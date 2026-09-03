import { state } from './state.js';
import { render, copyText } from './render.js';
import {
  startNewCase, loadSample, applyCsTemplate, submitIntake,
  detectIssuesFromLogs, selectDetectedIssue,
  runHypothesisGeneration, selectHypothesis, startCustomHypothesis,
  updateConfirmedHypField, onSeveritySelectChange, onSeverityReasonInput,
  confirmAndGenerateReport, retryStage, loadCaseFromHistory,
  handleReferenceDocUpload, removeReferenceDoc,
  updateReportField, updateEmailField, copyReportText, copyEmailText,
  onFinalReviewCheckboxChange, completeCase, downloadReportHtml, runPublishedComparison
} from './pipeline.js';
import {
  handleCsvFileUpload, handleZipUpload,
  toggleSourceSelected, toggleSourcePreview, removeSource,
  setSourceEncoding, setSourceEntityFilter, startSourceProcessing
} from './zip.js';

// Render templates use inline event-handler attributes (onclick="fn(...)"),
// which the browser resolves against the global scope — so every handler
// referenced from render.js's HTML strings, plus the mutable `state` object
// used by inline oninput bindings, must be exposed on `window`.
// `render` is exposed for the same reason state is: something outside the
// module graph writes state and needs the view redrawn. It is the redraw
// the resume path uses after seeding a saved run; exposing it changes no
// app behaviour.
Object.assign(window, {
  state, render,
  startNewCase, loadSample, applyCsTemplate, submitIntake,
  detectIssuesFromLogs, selectDetectedIssue,
  runHypothesisGeneration, selectHypothesis, startCustomHypothesis,
  updateConfirmedHypField, onSeveritySelectChange, onSeverityReasonInput,
  confirmAndGenerateReport, retryStage, loadCaseFromHistory,
  handleReferenceDocUpload, removeReferenceDoc,
  updateReportField, updateEmailField, copyReportText, copyEmailText,
  onFinalReviewCheckboxChange, completeCase, downloadReportHtml, runPublishedComparison,
  handleCsvFileUpload, handleZipUpload,
  toggleSourceSelected, toggleSourcePreview, removeSource,
  setSourceEncoding, setSourceEntityFilter, startSourceProcessing,
  copyText
});

startNewCase();
