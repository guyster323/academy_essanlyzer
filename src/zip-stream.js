import pako from 'pako';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const UINT32_MAX = 0xffffffff;
const EOCD_MIN_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP64_RECORD_BYTES = 64 * 1024 * 1024;
const FALLBACK_INPUT_CHUNK_BYTES = 64 * 1024;
const INFLATE_INPUT_CHUNK_BYTES = 8 * 1024;
const INFLATE_OUTPUT_CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_INFLATE_OUTPUT_BYTES = 8 * 1024 * 1024;

const archiveIndexCache = new WeakMap();

function asUint8Array(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function readUint64(view, offset, label) {
  const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`ZIP fallback ${label} exceeds JavaScript's safe integer range`);
  }
  return value;
}

function findEocd(bytes) {
  for (let i = bytes.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (bytes[i] === (END_OF_CENTRAL_DIRECTORY_SIGNATURE & 0xff) &&
        bytes[i + 1] === ((END_OF_CENTRAL_DIRECTORY_SIGNATURE >>> 8) & 0xff) &&
        bytes[i + 2] === ((END_OF_CENTRAL_DIRECTORY_SIGNATURE >>> 16) & 0xff) &&
        bytes[i + 3] === ((END_OF_CENTRAL_DIRECTORY_SIGNATURE >>> 24) & 0xff)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, bytes.byteLength - i);
      if (i + EOCD_MIN_BYTES + view.getUint16(20, true) === bytes.byteLength) return i;
    }
  }
  return -1;
}

function findRecordEndingAt(bytes, signature, endOffset) {
  for (let i = Math.min(bytes.byteLength - 12, endOffset - 12); i >= 0; i--) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + i, bytes.byteLength - i);
    if (view.getUint32(0, true) !== signature) continue;
    const recordSize = view.getUint32(4, true) + view.getUint32(8, true) * 0x100000000;
    if (Number.isSafeInteger(recordSize) && recordSize >= 44 && i + 12 + recordSize === endOffset) return i;
  }
  return -1;
}

function decodeFileName(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\\/g, '/');
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function readArchiveRange(archiveBlob, start, end, label) {
  if (!archiveBlob || typeof archiveBlob.slice !== 'function' || typeof archiveBlob.size !== 'number') {
    throw new Error('ZIP fallback requires the original File/Blob with random-access slice()');
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > archiveBlob.size) {
    throw new Error(`ZIP fallback ${label} range is outside the archive`);
  }
  const part = archiveBlob.slice(start, end);
  if (!part || typeof part.arrayBuffer !== 'function') {
    throw new Error(`ZIP fallback cannot read ${label} through File.slice()`);
  }
  const bytes = asUint8Array(await part.arrayBuffer());
  if (bytes.byteLength !== end - start) {
    throw new Error(`ZIP fallback read a short ${label} range (${bytes.byteLength}/${end - start} bytes)`);
  }
  return bytes;
}

async function hasSignatureAt(archiveBlob, offset, signature) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > archiveBlob.size) return false;
  try {
    const bytes = await readArchiveRange(archiveBlob, offset, offset + 4, 'signature probe');
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === signature;
  } catch {
    return false;
  }
}

async function findCentralDirectoryEndCandidates(archiveBlob, footerEnd) {
  const regionStart = Math.max(0, footerEnd - (6 + MAX_ZIP_COMMENT_BYTES));
  const region = await readArchiveRange(archiveBlob, regionStart, footerEnd, 'central-directory trailer');
  const candidates = [footerEnd];
  for (let i = region.byteLength - 6; i >= 0; i--) {
    const view = new DataView(region.buffer, region.byteOffset + i, region.byteLength - i);
    if (view.getUint32(0, true) !== 0x05054b50) continue;
    const signatureSize = view.getUint16(4, true);
    if (i + 6 + signatureSize === region.byteLength) candidates.push(regionStart + i);
  }
  return candidates;
}

function hasCentralDirectoryShape(bytes, recordCount) {
  let cursor = 0;
  for (let record = 0; record < recordCount; record++) {
    if (cursor + 46 > bytes.byteLength) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.byteLength - cursor);
    if (view.getUint32(0, true) !== CENTRAL_FILE_HEADER_SIGNATURE) return false;
    const fileNameLength = view.getUint16(28, true);
    const extraFieldLength = view.getUint16(30, true);
    const fileCommentLength = view.getUint16(32, true);
    const recordLength = 46 + fileNameLength + extraFieldLength + fileCommentLength;
    if (cursor + recordLength > bytes.byteLength) return false;
    cursor += recordLength;
  }
  return cursor === bytes.byteLength;
}

function parseZip64Extra(extraBytes, fields) {
  let cursor = 0;
  while (cursor + 4 <= extraBytes.byteLength) {
    const view = new DataView(extraBytes.buffer, extraBytes.byteOffset + cursor, extraBytes.byteLength - cursor);
    const fieldId = view.getUint16(0, true);
    const fieldLength = view.getUint16(2, true);
    cursor += 4;
    if (cursor + fieldLength > extraBytes.byteLength) break;
    if (fieldId === 0x0001) {
      const value = extraBytes.subarray(cursor, cursor + fieldLength);
      const valueView = new DataView(value.buffer, value.byteOffset, value.byteLength);
      let valueOffset = 0;
      const readIfNeeded = (name) => {
        if (!fields[name].needed) return;
        if (valueOffset + 8 > valueView.byteLength) {
          throw new Error(`ZIP fallback ZIP64 extra field is truncated while reading ${name}`);
        }
        fields[name].value = readUint64(valueView, valueOffset, name);
        fields[name].needed = false;
        valueOffset += 8;
      };
      readIfNeeded('uncompressedSize');
      readIfNeeded('compressedSize');
      readIfNeeded('localHeaderOffset');
    }
    cursor += fieldLength;
  }
}

function resolveZip64Value(value32, name) {
  return { needed: value32 === UINT32_MAX, value: value32 === UINT32_MAX ? null : value32, name };
}

function findArchiveEntry(index, entry) {
  const names = [entry?.name, entry?.unsafeOriginalName].filter(Boolean).map(name => String(name).replace(/\\/g, '/'));
  for (const name of names) {
    const metadata = index.get(name);
    if (metadata) return metadata;
  }
  throw new Error(`ZIP fallback could not find central-directory metadata for '${entry?.name || 'unknown entry'}'`);
}

async function locateZip64Record(archiveBlob, tail, tailStart, locatorAbsoluteOffset, locatorBytes) {
  const locatorView = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength);
  const declaredOffset = readUint64(locatorView, 8, 'ZIP64 locator offset');
  const tryCandidate = async (candidateOffset) => {
    if (!Number.isSafeInteger(candidateOffset) || candidateOffset < 0 || candidateOffset + 12 > archiveBlob.size) return null;
    const header = await readArchiveRange(archiveBlob, candidateOffset, candidateOffset + 12, 'ZIP64 end-of-central-directory header');
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (headerView.getUint32(0, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) return null;
    const recordSize = readUint64(headerView, 4, 'ZIP64 record size');
    if (recordSize < 44 || recordSize > MAX_ZIP64_RECORD_BYTES || candidateOffset + 12 + recordSize !== locatorAbsoluteOffset) return null;
    const record = await readArchiveRange(archiveBlob, candidateOffset, candidateOffset + 12 + recordSize, 'ZIP64 end-of-central-directory record');
    return { offset: candidateOffset, bytes: record };
  };

  const declaredRecord = await tryCandidate(declaredOffset);
  if (declaredRecord) return declaredRecord;

  const locatorRelativeOffset = locatorAbsoluteOffset - tailStart;
  const recordRelativeOffset = findRecordEndingAt(tail, ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, locatorRelativeOffset);
  if (recordRelativeOffset >= 0) {
    const record = await tryCandidate(tailStart + recordRelativeOffset);
    if (record) return record;
  }
  throw new Error('ZIP fallback could not locate the ZIP64 end-of-central-directory record');
}

async function buildArchiveIndex(archiveBlob) {
  const archiveSize = archiveBlob?.size;
  if (!Number.isSafeInteger(archiveSize) || archiveSize < EOCD_MIN_BYTES) {
    throw new Error('ZIP fallback cannot inspect an archive without a safe byte size');
  }

  const tailStart = Math.max(0, archiveSize - (EOCD_MIN_BYTES + MAX_ZIP_COMMENT_BYTES));
  const tail = await readArchiveRange(archiveBlob, tailStart, archiveSize, 'ZIP tail');
  const eocdRelativeOffset = findEocd(tail);
  if (eocdRelativeOffset < 0 || eocdRelativeOffset + EOCD_MIN_BYTES > tail.byteLength) {
    throw new Error('ZIP fallback could not find the end-of-central-directory record');
  }

  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdRelativeOffset, tail.byteLength - eocdRelativeOffset);
  const eocdAbsoluteOffset = tailStart + eocdRelativeOffset;
  const diskNumber = eocd.getUint16(4, true);
  const centralDirectoryDisk = eocd.getUint16(6, true);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error('ZIP fallback does not support multi-disk archives');
  }

  let recordCount = eocd.getUint16(10, true);
  let centralDirectorySize = eocd.getUint32(12, true);
  let centralDirectoryOffset = eocd.getUint32(16, true);
  let centralDirectoryFooterEnd = eocdAbsoluteOffset;
  let zip64Record = null;
  let zip64LocatorBytes = null;

  const hasZip64Sentinel = recordCount === 0xffff || centralDirectorySize === UINT32_MAX || centralDirectoryOffset === UINT32_MAX;
  if (hasZip64Sentinel) {
    const locatorAbsoluteOffset = eocdAbsoluteOffset - 20;
    if (locatorAbsoluteOffset < 0) throw new Error('ZIP fallback could not find the ZIP64 locator');
    zip64LocatorBytes = await readArchiveRange(archiveBlob, locatorAbsoluteOffset, locatorAbsoluteOffset + 20, 'ZIP64 locator');
    const locator = new DataView(zip64LocatorBytes.buffer, zip64LocatorBytes.byteOffset, zip64LocatorBytes.byteLength);
    if (locator.getUint32(0, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE ||
        locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
      throw new Error('ZIP fallback does not support multi-disk ZIP64 archives');
    }
    zip64Record = await locateZip64Record(archiveBlob, tail, tailStart, locatorAbsoluteOffset, zip64LocatorBytes);
    const zip64 = new DataView(zip64Record.bytes.buffer, zip64Record.bytes.byteOffset, zip64Record.bytes.byteLength);
    const diskNumber = zip64.getUint32(16, true);
    const centralDirectoryDisk = zip64.getUint32(20, true);
    const recordsOnDisk = readUint64(zip64, 24, 'ZIP64 records on disk');
    recordCount = readUint64(zip64, 32, 'central-directory record count');
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || recordsOnDisk !== recordCount) {
      throw new Error('ZIP fallback does not support multi-disk ZIP64 archives');
    }
    centralDirectorySize = readUint64(zip64, 40, 'central-directory size');
    centralDirectoryOffset = readUint64(zip64, 48, 'central-directory offset');
    centralDirectoryFooterEnd = zip64Record.offset;
  }

  if (!Number.isSafeInteger(recordCount) || recordCount < 0 ||
      !Number.isSafeInteger(centralDirectorySize) || centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(`ZIP fallback central directory is too large (${centralDirectorySize} bytes)`);
  }
  if (!Number.isSafeInteger(centralDirectoryOffset)) {
    throw new Error('ZIP fallback central-directory offset is not a safe integer');
  }
  if (recordCount > Math.floor(centralDirectorySize / 46)) {
    throw new Error(`ZIP fallback central-directory record count is inconsistent (${recordCount})`);
  }

  const rawCentralDirectoryLooksValid = centralDirectorySize === 0
    ? centralDirectoryOffset <= archiveSize
    : centralDirectoryOffset + centralDirectorySize <= centralDirectoryFooterEnd &&
      await hasSignatureAt(archiveBlob, centralDirectoryOffset, CENTRAL_FILE_HEADER_SIGNATURE);
  let physicalCentralDirectoryOffset = null;
  let centralDirectoryEnd = null;
  let centralDirectory = null;
  if (rawCentralDirectoryLooksValid) {
    physicalCentralDirectoryOffset = centralDirectoryOffset;
    centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
    centralDirectory = await readArchiveRange(
      archiveBlob,
      physicalCentralDirectoryOffset,
      physicalCentralDirectoryOffset + centralDirectorySize,
      'central directory'
    );
  } else {
    const endCandidates = await findCentralDirectoryEndCandidates(archiveBlob, centralDirectoryFooterEnd);
    for (const candidateEnd of endCandidates) {
      const candidateOffset = candidateEnd - centralDirectorySize;
      if (!Number.isSafeInteger(candidateOffset) || candidateOffset < 0 ||
          candidateOffset + centralDirectorySize > candidateEnd || candidateOffset + centralDirectorySize > archiveSize) continue;
      const candidate = await readArchiveRange(
        archiveBlob,
        candidateOffset,
        candidateOffset + centralDirectorySize,
        'central directory candidate'
      );
      if (!hasCentralDirectoryShape(candidate, recordCount)) continue;
      physicalCentralDirectoryOffset = candidateOffset;
      centralDirectoryEnd = candidateEnd;
      centralDirectory = candidate;
      break;
    }
    if (!centralDirectory) {
      throw new Error('ZIP fallback could not locate a structurally valid central directory');
    }
  }
  if (!Number.isSafeInteger(physicalCentralDirectoryOffset) || physicalCentralDirectoryOffset < 0 ||
      physicalCentralDirectoryOffset + centralDirectorySize > centralDirectoryEnd ||
      physicalCentralDirectoryOffset + centralDirectorySize > archiveSize) {
    throw new Error('ZIP fallback central-directory range is outside the archive');
  }
  const archiveBaseOffset = physicalCentralDirectoryOffset - centralDirectoryOffset;
  if (!Number.isSafeInteger(archiveBaseOffset) || archiveBaseOffset < 0) {
    throw new Error('ZIP fallback could not determine the archive base offset');
  }
  if (zip64Record) {
    const locatorOffset = readUint64(new DataView(zip64LocatorBytes.buffer, zip64LocatorBytes.byteOffset, zip64LocatorBytes.byteLength), 8, 'ZIP64 locator offset');
    if (locatorOffset + archiveBaseOffset !== zip64Record.offset) {
      throw new Error('ZIP fallback ZIP64 locator offset does not match the archive base offset');
    }
  }
  const index = new Map();
  let cursor = 0;
  let parsedRecords = 0;
  while (cursor + 46 <= centralDirectory.byteLength && parsedRecords < recordCount) {
    const view = new DataView(centralDirectory.buffer, centralDirectory.byteOffset + cursor, centralDirectory.byteLength - cursor);
    if (view.getUint32(0, true) !== CENTRAL_FILE_HEADER_SIGNATURE) break;

    const flags = view.getUint16(8, true);
    const compressionMethod = view.getUint16(10, true);
    const compressedSizeField = view.getUint32(20, true);
    const uncompressedSizeField = view.getUint32(24, true);
    const fileNameLength = view.getUint16(28, true);
    const extraFieldLength = view.getUint16(30, true);
    const fileCommentLength = view.getUint16(32, true);
    const localHeaderOffsetField = view.getUint32(42, true);
    const recordLength = 46 + fileNameLength + extraFieldLength + fileCommentLength;
    if (cursor + recordLength > centralDirectory.byteLength) {
      throw new Error('ZIP fallback central-directory record is truncated');
    }

    const fileNameStart = cursor + 46;
    const extraStart = fileNameStart + fileNameLength;
    const fileName = decodeFileName(centralDirectory.subarray(fileNameStart, extraStart));
    const fileNameBytes = centralDirectory.subarray(fileNameStart, extraStart).slice();
    const extraFields = centralDirectory.subarray(extraStart, extraStart + extraFieldLength);
    const fields = {
      uncompressedSize: resolveZip64Value(uncompressedSizeField, 'uncompressedSize'),
      compressedSize: resolveZip64Value(compressedSizeField, 'compressedSize'),
      localHeaderOffset: resolveZip64Value(localHeaderOffsetField, 'localHeaderOffset')
    };
    parseZip64Extra(extraFields, fields);
    if (fields.uncompressedSize.needed || fields.compressedSize.needed || fields.localHeaderOffset.needed) {
      throw new Error(`ZIP fallback is missing required ZIP64 values for '${fileName}'`);
    }

    const localHeaderOffset = fields.localHeaderOffset.value + archiveBaseOffset;
    if (!Number.isSafeInteger(localHeaderOffset)) {
      throw new Error(`ZIP fallback local-header offset is not a safe integer for '${fileName}'`);
    }
    index.set(fileName, {
      fileName,
      fileNameBytes,
      flags,
      compressionMethod,
      compressedSize: fields.compressedSize.value,
      uncompressedSize: fields.uncompressedSize.value,
      localHeaderOffset
    });
    cursor += recordLength;
    parsedRecords++;
  }

  if (parsedRecords !== recordCount) {
    throw new Error(`ZIP fallback parsed ${parsedRecords} of ${recordCount} central-directory records`);
  }
  return index;
}

async function getArchiveIndex(archiveBlob) {
  let indexPromise = archiveIndexCache.get(archiveBlob);
  if (!indexPromise) {
    indexPromise = buildArchiveIndex(archiveBlob);
    archiveIndexCache.set(archiveBlob, indexPromise);
  }
  try {
    return await indexPromise;
  } catch (error) {
    archiveIndexCache.delete(archiveBlob);
    throw error;
  }
}

async function readEntryLayout(entry, archiveBlob) {
  const metadata = findArchiveEntry(await getArchiveIndex(archiveBlob), entry);
  if ((metadata.flags & 0x0001) !== 0) {
    throw new Error(`ZIP fallback does not support encrypted entry '${metadata.fileName}'`);
  }
  const localHeaderOffset = metadata.localHeaderOffset;
  const localHeader = await readArchiveRange(archiveBlob, localHeaderOffset, localHeaderOffset + 30, 'local file header');
  const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`ZIP fallback found no local file header at offset ${localHeaderOffset}`);
  }

  const flags = view.getUint16(6, true);
  const compressionMethod = view.getUint16(8, true);
  const compressedSizeField = view.getUint32(18, true);
  const uncompressedSizeField = view.getUint32(22, true);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);
  const variableHeader = await readArchiveRange(
    archiveBlob,
    localHeaderOffset + 30,
    localHeaderOffset + 30 + fileNameLength + extraFieldLength,
    'local file header fields'
  );
  const localFileNameBytes = variableHeader.subarray(0, fileNameLength);
  if (!equalBytes(localFileNameBytes, metadata.fileNameBytes)) {
    throw new Error(`ZIP fallback local/central file name mismatch for '${metadata.fileName}'`);
  }
  const localExtraFields = variableHeader.subarray(fileNameLength);
  const localFields = {
    uncompressedSize: resolveZip64Value(uncompressedSizeField, 'uncompressedSize'),
    compressedSize: resolveZip64Value(compressedSizeField, 'compressedSize'),
    localHeaderOffset: { needed: false, value: localHeaderOffset, name: 'localHeaderOffset' }
  };
  parseZip64Extra(localExtraFields, localFields);

  if (flags !== metadata.flags) {
    throw new Error(`ZIP fallback local/central flags mismatch for '${metadata.fileName}'`);
  }
  if (compressionMethod !== metadata.compressionMethod) {
    throw new Error(`ZIP fallback local/central compression method mismatch for '${metadata.fileName}'`);
  }

  const usesDataDescriptor = (flags & 0x0008) !== 0;
  if (!usesDataDescriptor && (localFields.compressedSize.needed || localFields.uncompressedSize.needed)) {
    throw new Error(`ZIP fallback local header is missing ZIP64 sizes for '${metadata.fileName}'`);
  }
  if (!usesDataDescriptor && localFields.compressedSize.value !== metadata.compressedSize) {
    throw new Error(`ZIP fallback local/central size mismatch for '${metadata.fileName}'`);
  }
  const compressedSize = (!usesDataDescriptor && !localFields.compressedSize.needed)
    ? localFields.compressedSize.value
    : metadata.compressedSize;
  // The uncompressed field is the value that JSZip reads as a signed 32-bit
  // integer in the affected archive. When a local header has a usable value,
  // it is the authoritative bound for this direct stream; the final byte
  // count check still rejects truncated or overlong data.
  const expectedUncompressedSize = (!usesDataDescriptor && !localFields.uncompressedSize.needed)
    ? localFields.uncompressedSize.value
    : metadata.uncompressedSize;
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0) {
    throw new Error(`ZIP fallback has no safe compressed size for '${metadata.fileName}'`);
  }
  if (!Number.isSafeInteger(expectedUncompressedSize) || expectedUncompressedSize < 0) {
    throw new Error(`ZIP fallback has no safe uncompressed size for '${metadata.fileName}'`);
  }

  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  if (!Number.isSafeInteger(dataOffset) || dataOffset + compressedSize > archiveBlob.size) {
    throw new Error(`ZIP fallback compressed range for '${metadata.fileName}' exceeds the archive`);
  }
  return { fileName: metadata.fileName, flags, compressionMethod, dataOffset, compressedSize, expectedUncompressedSize };
}

async function* readCompressedRanges(archiveBlob, start, length) {
  for (let offset = 0; offset < length; offset += FALLBACK_INPUT_CHUNK_BYTES) {
    const end = Math.min(length, offset + FALLBACK_INPUT_CHUNK_BYTES);
    yield await readArchiveRange(archiveBlob, start + offset, start + end, 'compressed entry');
  }
}

function inflateError(inflater, fileName) {
  const detail = inflater.msg ? `: ${inflater.msg}` : '';
  return new Error(`ZIP fallback deflate inflate failed for '${fileName}'${detail}`);
}

function validateOutputLength(fileName, actual, expected) {
  if (actual !== expected) {
    throw new Error(`ZIP fallback output length mismatch for '${fileName}' (expected ${expected}, got ${actual})`);
  }
}

async function* directZipEntryByteChunks(entry, archiveBlob) {
  const layout = await readEntryLayout(entry, archiveBlob);
  if (layout.compressionMethod === 0) {
    let outputBytes = 0;
    for await (const chunk of readCompressedRanges(archiveBlob, layout.dataOffset, layout.compressedSize)) {
      outputBytes += chunk.byteLength;
      yield chunk;
    }
    validateOutputLength(layout.fileName, outputBytes, layout.expectedUncompressedSize);
    return;
  }
  if (layout.compressionMethod !== 8) {
    throw new Error(`ZIP fallback does not support compression method ${layout.compressionMethod} for '${layout.fileName}'`);
  }

  const pending = [];
  let pendingBytes = 0;
  let pendingError = null;
  let outputBytes = 0;
  const inflater = new pako.Inflate({ raw: true, chunkSize: INFLATE_OUTPUT_CHUNK_BYTES });
  inflater.onData = (chunk) => {
    if (pendingError) return;
    const output = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (pendingBytes + output.byteLength > MAX_PENDING_INFLATE_OUTPUT_BYTES) {
      pendingError = new Error(`ZIP fallback inflate output queue exceeded ${MAX_PENDING_INFLATE_OUTPUT_BYTES} bytes for '${layout.fileName}'`);
      return;
    }
    pending.push(output);
    pendingBytes += output.byteLength;
  };

  for await (const chunk of readCompressedRanges(archiveBlob, layout.dataOffset, layout.compressedSize)) {
    // pako drains an entire push synchronously. Feed small subchunks so a
    // legal high-ratio DEFLATE stream cannot create an unbounded callback
    // queue before this async generator gets a chance to yield.
    for (let offset = 0; offset < chunk.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
      const input = chunk.subarray(offset, Math.min(chunk.byteLength, offset + INFLATE_INPUT_CHUNK_BYTES));
      if (!inflater.push(input, false)) throw inflateError(inflater, layout.fileName);
      if (pendingError) throw pendingError;
      while (pending.length) {
        const output = pending.shift();
        pendingBytes -= output.byteLength;
        outputBytes += output.byteLength;
        yield output;
      }
    }
  }
  if (!inflater.ended && !inflater.push(new Uint8Array(0), true)) {
    throw inflateError(inflater, layout.fileName);
  }
  if (pendingError) throw pendingError;
  while (pending.length) {
    const output = pending.shift();
    pendingBytes -= output.byteLength;
    outputBytes += output.byteLength;
    yield output;
  }
  if (inflater.err) throw inflateError(inflater, layout.fileName);
  validateOutputLength(layout.fileName, outputBytes, layout.expectedUncompressedSize);
}

function jsZipEntryByteChunks(entry) {
  return {
    [Symbol.asyncIterator]() {
      const stream = entry.internalStream('uint8array');
      const queue = [];
      let waiter = null, ended = false, errored = null;
      stream.on('data', (chunk) => {
        queue.push(chunk);
        stream.pause();
        if (waiter) { const resolve = waiter; waiter = null; resolve(); }
      });
      stream.on('end', () => {
        ended = true;
        if (waiter) { const resolve = waiter; waiter = null; resolve(); }
      });
      stream.on('error', (error) => {
        errored = error;
        if (waiter) { const resolve = waiter; waiter = null; resolve(); }
      });
      stream.resume();
      return {
        async next() {
          while (queue.length === 0 && !ended && !errored) {
            await new Promise(resolve => { waiter = resolve; });
          }
          if (errored) throw errored;
          if (queue.length) {
            const chunk = queue.shift();
            stream.resume();
            return { value: chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), done: false };
          }
          return { value: undefined, done: true };
        },
        async return() {
          ended = true;
          stream.pause();
          if (typeof stream.removeAllListeners === 'function') {
            stream.removeAllListeners('data');
            stream.removeAllListeners('end');
            stream.removeAllListeners('error');
            stream.on('error', () => {});
          }
          if (waiter) { const resolve = waiter; waiter = null; resolve(); }
          return { value: undefined, done: true };
        }
      };
    }
  };
}

export function isJsZipUncompressedSizeMismatch(error) {
  return /^Bug\s*:\s*uncompressed data size mismatch$/i.test(String(error?.message || error || '').trim());
}

export function zipEntryByteChunks(entry, archiveBlob, options = {}) {
  const forceDirect = options && options.forceDirect === true;
  const reportedSize = Number(entry?._data?.uncompressedSize);
  const signedSizeBug = Number.isFinite(reportedSize) && reportedSize < 0;
  if (archiveBlob && (forceDirect || signedSizeBug)) {
    return directZipEntryByteChunks(entry, archiveBlob);
  }
  return jsZipEntryByteChunks(entry);
}
