'use strict';

/**
 * Step: Session Signal Detection + Quality Scoring (ADR-43)
 *
 * Detect signals from session decision/error logs, score quality,
 * and capture experiences if warranted.
 *
 * Priority: 20
 * After: plugin-activate
 * Requires: _sessionSignalDetector, experienceStore
 */

const { TeardownStep } = require('../teardown-step');
const { SessionQualityScorer } = require('../session-quality-scorer');
const { getLayerForCategory } = require('../experience-types');
const { prepareGatewayPrompt } = require('../llm-injection-gateway');

class SessionSignalStep extends TeardownStep {
  constructor() {
    super({
      name: 'session-signal',
      description: 'Detect session signals and score quality (ADR-43)',
      priority: 20,
      after: ['plugin-activate'],
      requires: ['_sessionSignalDetector', 'experienceStore'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      // 1. Gather session context for signal detection
      const decisionLogContent = orch.decisionTrail
        ? orch.decisionTrail.getTimeline().map(t => `${t.stage}: ${t.decision}`).join('\n')
        : '';
      const errorLogContent = orch.complaintWall
        ? orch.complaintWall.getOpenComplaints().map(c => c.description).join('\n')
        : '';

      // 2. Detect signals from session
      const signalResult = orch._sessionSignalDetector.detectSignals({
        decisionLog: decisionLogContent,
        errorLog: errorLogContent,
      });

      // 3. Score session quality
      const qualityScorer = new SessionQualityScorer({
        experienceStore: orch.experienceStore,
        verbose: orch._verbose,
      });
      const qualityResult = qualityScorer.scoreWithSignals(
        { decisionLog: decisionLogContent, errorLog: errorLogContent },
        signalResult
      );

      // 4. Capture experience if warranted
      if (qualityResult.shouldCapture && signalResult.signals.length > 0) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  🎯 SESSION SIGNAL CAPTURE (ADR-43)`);
        console.log(`${'─'.repeat(60)}`);
        console.log(`  Signals: ${signalResult.signals.length} (score: ${signalResult.score.toFixed(2)})`);
        console.log(`  Quality: ${qualityResult.qualityScore.toFixed(2)}`);
        console.log(`  Reason: ${qualityResult.reason}`);
        console.log(`${'─'.repeat(60)}\n`);

        // 5. Extract experience using LLM (only if signals detected)
        if (orch._rawLlmCall && signalResult.signals.length > 0) {
          const extractionPrompt = orch._sessionSignalDetector.buildExtractionPrompt({
            decisionLog: decisionLogContent,
            errorLog: errorLogContent,
          });

          orch._rawLlmCall(prepareGatewayPrompt(orch, {
            callSite: 'workflow/core/teardown-steps/session-signal-step.js:execute.extraction',
            role: 'session-signal',
            stage: 'FINISHED',
            runtimePrompt: extractionPrompt,
            metadata: { category: 'raw-orchestrator-call', signalCount: signalResult.signals.length },
          }), 'session-signal-extraction')
            .then(response => {
              if (!response) return;

              let extracted = null;
              try {
                let cleaned = response.trim();
                if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
                else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
                if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
                const startIdx = cleaned.indexOf('{');
                const endIdx = cleaned.lastIndexOf('}');
                if (startIdx !== -1 && endIdx !== -1) {
                  extracted = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
                }
              } catch (_) { /* parse error, ignore */ }

              if (extracted && extracted.experiences && Array.isArray(extracted.experiences)) {
                for (const exp of extracted.experiences.slice(0, 2)) {
                  if (!exp.title || !exp.content) continue;
                  const category = exp.category || 'pitfall';
                  const layer = getLayerForCategory(category);

                  orch.experienceStore.record({
                    type: exp.type || 'negative',
                    category,
                    title: exp.title,
                    content: `${exp.content}\n> _Source: Session Signal Detection (ADR-43)_`,
                    tags: [...(exp.tags || []), 'signal-captured', `layer:${layer}`],
                    ttlDays: exp.type === 'negative' ? 90 : 180,
                  });

                  console.log(`[Orchestrator] 📝 Captured experience: "${exp.title.slice(0, 50)}..." (layer: ${layer})`);
                }
              }
            })
            .catch(err => {
              console.warn(`[Orchestrator] ⚠️  Signal extraction failed (non-fatal): ${err.message}`);
            });
        }
      } else {
        console.log(`[Orchestrator] ⏭️  Session Signal Capture skipped (${qualityResult.reason})`);
      }

      // 6. Check experience store layer health
      if (orch.experienceStore.checkLayerHealth) {
        const layerHealth = orch.experienceStore.checkLayerHealth(0.5);
        if (!layerHealth.healthy) {
          console.warn(`[Orchestrator] ⚠️  ${layerHealth.recommendation}`);
        }
      }

      // 7. Reset detector for next session
      orch._sessionSignalDetector.reset();
    } catch (ssErr) {
      console.warn(`[Orchestrator] ⚠️  Session Signal Detection failed (non-fatal): ${ssErr.message}`);
    }
  }
}

module.exports = { SessionSignalStep };
