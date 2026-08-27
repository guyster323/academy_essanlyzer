/**
 * Tool (forced tool-use) definitions for the 4 pipeline stages. Field names
 * mirror the original prompt-engineered JSON shapes 1:1 so the frontend
 * render functions (renderDetectedIssues, renderAnomalyView,
 * renderHypothesisView, renderReportView) need no changes.
 *
 * `strict: true` is set on every tool (top-level field, sibling to
 * name/description/input_schema — NOT on tool_choice) so Claude's
 * tool_use.input is guaranteed to validate against input_schema exactly,
 * instead of only guaranteeing that the tool gets called. Every object
 * schema below (top-level and nested) declares `additionalProperties: false`
 * and lists every property in `required`, per Anthropic's strict tool use
 * requirements: https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
 */

export const detectIssuesTool = {
  name: 'report_detected_issues',
  description: 'BMS/EMS 로그에서 자동 탐지된 CS 이슈 후보 목록을 보고한다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      issues: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            occurredAt: { type: 'string' },
            sourceFile: { type: 'string' },
            description: { type: 'string' },
            alarmCodes: { type: 'array', items: { type: 'string' } },
            level: { type: 'string', enum: ['고', '중', '저'] }
          },
          required: ['id', 'title', 'occurredAt', 'sourceFile', 'description', 'alarmCodes', 'level']
        }
      }
    },
    required: ['issues']
  }
};

export const detectAnomalyTool = {
  name: 'report_anomaly_detection',
  description: 'CS 의뢰 구조화 결과와 로그에서 식별한 이상 구간 목록을 보고한다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      issueStructured: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issueType: { type: 'string' },
          facility: { type: 'string' },
          occurredAt: { type: 'string' },
          priorHistory: { type: 'string' }
        },
        required: ['issueType', 'facility', 'occurredAt', 'priorHistory']
      },
      anomalyWindows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timestamp: { type: 'string' },
            sourceFile: { type: 'string' },
            parameter: { type: 'string' },
            observedValue: { type: 'string' },
            normalRange: { type: 'string' },
            deviation: { type: 'string' },
            alarmCode: { type: 'string' },
            level: { type: 'string', enum: ['고', '중', '저'] }
          },
          required: ['timestamp', 'sourceFile', 'parameter', 'observedValue', 'normalRange', 'deviation', 'alarmCode', 'level']
        }
      }
    },
    required: ['issueStructured', 'anomalyWindows']
  }
};

export const hypothesesTool = {
  name: 'report_hypotheses',
  description: '이상 구간 패턴을 근거로 한 원인 가설 목록을 보고한다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      hypotheses: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            domain: {
              type: 'string',
              enum: ['Battery/BMS', 'PCS', 'EMS', 'Contactor/CB', 'Cooling/HVAC', 'Communication/Sensor']
            },
            expectedSignature: { type: 'string' },
            actualObservation: { type: 'string' },
            evidence: { type: 'string' },
            confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            severityDraft: { type: 'string', enum: ['상', '중', '하'] },
            severityReason: { type: 'string' }
          },
          required: [
            'id', 'name', 'domain', 'expectedSignature', 'actualObservation',
            'evidence', 'confidence', 'severityDraft', 'severityReason'
          ]
        }
      }
    },
    required: ['hypotheses']
  }
};

export const draftReportTool = {
  name: 'report_draft',
  description: '분석 보고서 초안과 CS 회신 메일 초안을 보고한다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      report: {
        type: 'object',
        additionalProperties: false,
        properties: {
          headline: { type: 'string' },
          occurrence: { type: 'string' },
          anomalySummary: { type: 'string' },
          rootCause: { type: 'string' },
          actionRecommendation: { type: 'string' }
        },
        required: ['headline', 'occurrence', 'anomalySummary', 'rootCause', 'actionRecommendation']
      },
      email: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    },
    required: ['report', 'email']
  }
};
