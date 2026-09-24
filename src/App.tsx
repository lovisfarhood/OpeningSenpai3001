import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';

import {
  AnnotationSection,
  StrategicIdeas,
} from './components/BookContent.js';
import { MoveList } from './components/MoveList.js';
import {
  OpeningWorkspace,
  type OpeningWorkspaceMode,
} from './components/OpeningWorkspace.js';
import { ExplorerWorkspace } from './components/ExplorerWorkspace.js';
import { LoadingScreen } from './components/LoadingScreen.js';
import {
  RepertoireBoard,
  type ChesslyBoardAnnotation,
  type PromotionPiece,
} from './components/RepertoireBoard.js';
import {
  candidateOrigins,
  loadOpeningIndex,
  loadPopularityPack,
  loadRepertoire,
  resolveAnnotations,
  type OpeningIndexEntry,
} from './data/repertoire.js';
import { ENGLISH } from './content/english.js';
import { localAdditionsToBranches } from './domain/local-branches.js';
import { restoreNavigationState, toNavigationState } from './domain/navigation.js';
import type {
  AnnotationMarks,
  CanonicalAnnotation,
  CanonicalRepertoire,
} from './domain/repertoire.js';
import {
  combineRepertoires,
  createCombinedOpenings,
  type CombinedOpening,
} from './domain/combined-openings.js';
import type { PopularityPack } from './domain/popularity.js';
import {
  createExplorerIndex,
  type ExplorerSource,
} from './domain/explorer.js';
import {
  analyzePgn,
  parsePgn,
  type ImportedPgn,
} from './domain/pgn.js';
import {
  addManualReply,
  choosePendingCandidate,
  choosePendingLocalBranch,
  createInitialSession,
  currentLineSans,
  forwardFullMove,
  playPendingBlackReply,
  playWhiteMove,
  restartSession,
  sessionPgn,
  undoFullMove,
  type ConflictSelections,
  type SessionResponse,
  type SessionState,
} from './domain/session.js';
import {
  buildCoursePacksFromBrowserFiles,
  importPackageToLocalAdditions,
  parseBrowserImportFiles,
  type BrowserImportFile,
  type ValidatedImportPackage,
} from './import/index.js';
import {
  DEFAULT_APP_SETTINGS,
  LocalDataConflictError,
  LocalDataRepository,
  CoursePackRepository,
  downloadLocalBackup,
  exportLocalBackup,
  importLocalBackup,
  loadNavigationState,
  loadSettings,
  resetLocalData,
  saveNavigationState,
  saveSettings,
  serializeLocalBackup,
  type AppSettings,
  type LocalAddition,
  type LocalOverride,
  type LocalOverrideInput,
  UserStateStore,
} from './storage/index.js';

interface LocalState {
  overrides: LocalOverride[];
  additions: LocalAddition[];
  selections: ConflictSelections;
}

const EMPTY_LOCAL_STATE: LocalState = {
  overrides: [],
  additions: [],
  selections: {},
};

function safeSettings(): AppSettings {
  try {
    return loadSettings();
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function overrideFor(
  overrides: LocalOverride[],
  targetId: string | null,
  field: LocalOverride['field'],
): LocalOverride | undefined {
  if (!targetId) {
    return undefined;
  }
  return overrides.find(
    (item) =>
      item.target.type === 'reply-candidate' &&
      item.target.id === targetId &&
      item.field === field,
  );
}

function marksFromOverride(
  override: LocalOverride | undefined,
): AnnotationMarks | null | undefined {
  return override?.field === 'arrows' || override?.field === 'highlights'
    ? override.value
    : undefined;
}

function textFromOverride(
  override: LocalOverride | undefined,
): string | null | undefined {
  return override?.field === 'reply-explanation' ||
    override?.field === 'resulting-plan'
    ? override.value
    : undefined;
}

function mergeMarks(
  annotations: CanonicalAnnotation[],
  field: 'arrows' | 'highlights',
): AnnotationMarks {
  return {
    threats: [
      ...new Set(
        annotations.flatMap(
          (annotation) => annotation[field]?.threats ?? [],
        ),
      ),
    ].sort(),
    opportunities: [
      ...new Set(
        annotations.flatMap(
          (annotation) => annotation[field]?.opportunities ?? [],
        ),
      ),
    ].sort(),
  };
}

function marksToInput(marks: AnnotationMarks): string {
  return marks.opportunities.join(', ');
}

function parseCoordinates(value: string, pattern: RegExp): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => pattern.test(item)),
    ),
  ].sort();
}

function responseAnnotations(
  repertoire: CanonicalRepertoire,
  response: SessionResponse | null,
): {
  explanations: CanonicalAnnotation[];
  plans: CanonicalAnnotation[];
} {
  if (!response || response.manual) {
    return { explanations: [], plans: [] };
  }
  return {
    explanations: resolveAnnotations(
      repertoire,
      response.blackTurnPosition,
      response.replyExplanationIds,
    ),
    plans: resolveAnnotations(
      repertoire,
      response.resultingWhiteTurnPosition,
      response.resultingPlanIds,
    ),
  };
}

function statusLabel(state: SessionState): string {
  switch (state.status) {
    case 'waiting':
      return 'Schwarz blättert zur Antwort …';
    case 'unknown':
      return 'Weiße Abweichung noch nicht erfasst';
    case 'conflict':
      return 'Antwortauswahl erforderlich';
    case 'missing-reply':
      return 'Schwarze Antwort fehlt';
    case 'error':
      return 'Datenfehler';
    default:
      return 'Weiß ist am Zug';
  }
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error('Zwischenablage ist nicht verfügbar.');
  }
  await navigator.clipboard.writeText(value);
}

export function RepertoireApplication({
  repertoire,
}: {
  repertoire: CanonicalRepertoire;
}) {
  const repository = useMemo(() => new LocalDataRepository(), []);
  const [settings, setSettings] = useState<AppSettings>(safeSettings);
  const [session, setSession] = useState<SessionState>(createInitialSession);
  const [local, setLocal] = useState<LocalState>(EMPTY_LOCAL_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [dataPanelOpen, setDataPanelOpen] = useState(false);
  const [manualSan, setManualSan] = useState('');
  const [manualExplanation, setManualExplanation] = useState('');
  const [manualPlans, setManualPlans] = useState('');
  const [editExplanation, setEditExplanation] = useState('');
  const [editPlans, setEditPlans] = useState('');
  const [editOpportunityArrows, setEditOpportunityArrows] = useState('');
  const [editThreatArrows, setEditThreatArrows] = useState('');
  const [editOpportunityHighlights, setEditOpportunityHighlights] =
    useState('');
  const [editThreatHighlights, setEditThreatHighlights] = useState('');
  const [importPreview, setImportPreview] =
    useState<ValidatedImportPackage | null>(null);
  const [importLabel, setImportLabel] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  const localBranches = useMemo(
    () => localAdditionsToBranches(local.additions),
    [local.additions],
  );

  const refreshLocalData = useCallback(async () => {
    const [overrides, additions, selections] = await Promise.all([
      repository.listOverrides(),
      repository.listAdditions(),
      repository.listConflictSelections(),
    ]);
    const selectionMap = Object.fromEntries(
      selections.map((selection) => [
        selection.decisionId,
        selection.replyCandidateId,
      ]),
    );
    setLocal({
      overrides,
      additions,
      selections: selectionMap,
    });
    return {
      additions,
      selections: selectionMap,
    };
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await refreshLocalData();
        if (cancelled) {
          return;
        }
        const navigation = loadNavigationState();
        setSession(
          restoreNavigationState(
            navigation,
            repertoire,
            loaded.selections,
            localAdditionsToBranches(loaded.additions),
          ),
        );
      } catch (error) {
        if (!cancelled) {
          setStorageWarning(
            error instanceof Error
              ? `Lokale Speicherung ist nicht verfügbar: ${error.message}`
              : 'Lokale Speicherung ist nicht verfügbar.',
          );
        }
      } finally {
        if (!cancelled) {
          setHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLocalData, repertoire, repository]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    try {
      saveNavigationState(toNavigationState(session));
    } catch (error) {
      setStorageWarning(
        error instanceof Error
          ? `Position konnte nicht gespeichert werden: ${error.message}`
          : 'Position konnte nicht gespeichert werden.',
      );
    }
  }, [hydrated, session]);

  useEffect(() => {
    if (session.status !== 'waiting') {
      return;
    }
    const timer = window.setTimeout(() => {
      setSession((current) => playPendingBlackReply(current, repertoire));
    }, 420);
    return () => window.clearTimeout(timer);
  }, [repertoire, session.status, session.pending]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const baseContent = useMemo(
    () => responseAnnotations(repertoire, session.response),
    [repertoire, session.response],
  );
  const localBranch = useMemo(
    () =>
      session.response?.manual
        ? localBranches.find(
            (branch) => branch.id === session.response?.candidateId,
          ) ?? null
        : null,
    [localBranches, session.response],
  );
  const targetId = session.response?.candidateId ?? null;
  const explanationOverride = textFromOverride(
    overrideFor(local.overrides, targetId, 'reply-explanation'),
  );
  const planOverride = textFromOverride(
    overrideFor(local.overrides, targetId, 'resulting-plan'),
  );
  const arrowOverride = marksFromOverride(
    overrideFor(local.overrides, targetId, 'arrows'),
  );
  const highlightOverride = marksFromOverride(
    overrideFor(local.overrides, targetId, 'highlights'),
  );
  const effectiveExplanation =
    explanationOverride !== undefined
      ? explanationOverride
      : localBranch
        ? localBranch.explanation
        : undefined;
  const effectivePlans =
    planOverride !== undefined
      ? planOverride
      : localBranch
        ? localBranch.plans
        : undefined;

  const boardAnnotations = useMemo<ChesslyBoardAnnotation[]>(() => {
    if (session.status === 'waiting' && session.pending?.localBranch) {
      return [
        {
          arrows: session.pending.localBranch.replyArrows ?? null,
          highlights: session.pending.localBranch.replyHighlights ?? null,
        },
      ];
    }
    if (
      session.status === 'waiting' &&
      session.pending?.option &&
      session.pending.candidateId
    ) {
      const candidate = session.pending.option.candidates.find(
        (item) => item.id === session.pending?.candidateId,
      );
      return candidate
        ? resolveAnnotations(
            repertoire,
            candidate.blackTurnPosition,
            candidate.replyExplanationIds,
          )
        : [];
    }
    const sourceAnnotations: ChesslyBoardAnnotation[] = localBranch
      ? [
          {
            arrows: localBranch.resultingArrows ?? null,
            highlights: localBranch.resultingHighlights ?? null,
          },
        ]
      : baseContent.plans;
    const base = sourceAnnotations.map((annotation) => ({
      arrows:
        arrowOverride !== undefined ? null : (annotation.arrows ?? null),
      highlights:
        highlightOverride !== undefined
          ? null
          : (annotation.highlights ?? null),
    }));
    if (arrowOverride !== undefined || highlightOverride !== undefined) {
      base.push({
        arrows: arrowOverride ?? null,
        highlights: highlightOverride ?? null,
      });
    }
    return base;
  }, [
    arrowOverride,
    baseContent.plans,
    highlightOverride,
    localBranch,
    repertoire,
    session.pending,
    session.status,
  ]);

  useEffect(() => {
    const explanation =
      effectiveExplanation ??
      baseContent.explanations.map((annotation) => annotation.text).join('\n\n');
    const plans =
      effectivePlans ??
      baseContent.plans.map((annotation) => annotation.text).join('\n\n');
    const arrows =
      arrowOverride !== undefined
        ? arrowOverride ?? { threats: [], opportunities: [] }
        : localBranch?.resultingArrows ??
          mergeMarks(baseContent.plans, 'arrows');
    const highlights =
      highlightOverride !== undefined
        ? highlightOverride ?? { threats: [], opportunities: [] }
        : localBranch?.resultingHighlights ??
          mergeMarks(baseContent.plans, 'highlights');
    setEditExplanation(explanation ?? '');
    setEditPlans(plans ?? '');
    setEditOpportunityArrows(marksToInput(arrows));
    setEditThreatArrows(arrows.threats.join(', '));
    setEditOpportunityHighlights(marksToInput(highlights));
    setEditThreatHighlights(highlights.threats.join(', '));
  }, [
    arrowOverride,
    baseContent.explanations,
    baseContent.plans,
    effectiveExplanation,
    effectivePlans,
    highlightOverride,
    localBranch,
    targetId,
  ]);

  const handleWhiteMove = useCallback(
    (from: string, to: string, promotion: PromotionPiece | undefined) => {
      const transition = playWhiteMove(
        session,
        {
          from,
          to,
          ...(promotion ? { promotion } : {}),
        },
        repertoire,
        local.selections,
        localBranches,
      );
      if (transition.accepted) {
        setSession(transition.state);
      }
      return transition.accepted;
    },
    [local.selections, localBranches, repertoire, session],
  );

  const updateSetting = (changes: Partial<AppSettings>) => {
    const next = { ...settings, ...changes };
    setSettings(next);
    try {
      saveSettings(next);
    } catch {
      setStorageWarning('Einstellungen konnten nicht gespeichert werden.');
    }
  };

  const selectBaseCandidate = async (candidateId: string) => {
    const decisionId = session.pending?.option?.id;
    if (!decisionId) {
      return;
    }
    try {
      await repository.setConflictSelection(decisionId, candidateId);
      setLocal((current) => ({
        ...current,
        selections: {
          ...current.selections,
          [decisionId]: candidateId,
        },
      }));
    } catch {
      setStorageWarning('Die Antwortauswahl konnte nicht gespeichert werden.');
    }
    setSession((current) => choosePendingCandidate(current, candidateId));
  };

  const selectLocalCandidate = async (branchId: string) => {
    const decisionId = session.pending?.localDecisionId;
    if (!decisionId) {
      return;
    }
    try {
      await repository.setConflictSelection(decisionId, branchId);
      setLocal((current) => ({
        ...current,
        selections: { ...current.selections, [decisionId]: branchId },
      }));
    } catch {
      setStorageWarning('Die lokale Antwortauswahl konnte nicht gespeichert werden.');
    }
    setSession((current) => choosePendingLocalBranch(current, branchId));
  };

  const addLocalBranch = async (event: FormEvent) => {
    event.preventDefault();
    if (!manualSan.trim()) {
      return;
    }
    const pending = session.pending;
    const result = addManualReply(
      session,
      manualSan.trim(),
      manualExplanation,
      manualPlans,
    );
    if (!result.branch || !pending) {
      setSession(result.state);
      return;
    }
    try {
      const addition = await repository.saveAddition({
        id: result.branch.id,
        sourceType: 'user',
        branchId: result.branch.id,
        baseDecisionId: pending.option?.id ?? null,
        whiteTurnPosition: result.branch.startPosition,
        whiteMoveSan: result.branch.whiteSan,
        blackTurnPosition: pending.blackTurnPosition,
        replies: [
          {
            id: result.branch.id,
            san: result.branch.blackSan,
            resultingWhiteTurnPosition: result.branch.resultingPosition,
            replyExplanation: {
              text: result.branch.explanation,
              arrows: null,
              highlights: null,
            },
            resultingPlan: {
              text: result.branch.plans,
              arrows: null,
              highlights: null,
            },
          },
        ],
      });
      setLocal((current) => ({
        ...current,
        additions: [
          ...current.additions.filter((item) => item.id !== addition.id),
          addition,
        ],
      }));
      setSession(result.state);
      setManualSan('');
      setManualExplanation('');
      setManualPlans('');
      setToast('Lokaler Ast gespeichert');
    } catch (error) {
      setStorageWarning(
        error instanceof Error
          ? `Lokaler Ast konnte nicht gespeichert werden: ${error.message}`
          : 'Lokaler Ast konnte nicht gespeichert werden.',
      );
    }
  };

  const saveEdits = async (event: FormEvent) => {
    event.preventDefault();
    if (!targetId) {
      return;
    }
    const target = { type: 'reply-candidate' as const, id: targetId };
    const inputs: LocalOverrideInput[] = [
      {
        target,
        field: 'reply-explanation',
        value: editExplanation.trim() || null,
      },
      {
        target,
        field: 'resulting-plan',
        value: editPlans.trim() || null,
      },
      {
        target,
        field: 'arrows',
        value: {
          opportunities: parseCoordinates(
            editOpportunityArrows,
            /^[a-h][1-8]-[a-h][1-8]$/,
          ),
          threats: parseCoordinates(
            editThreatArrows,
            /^[a-h][1-8]-[a-h][1-8]$/,
          ),
        },
      },
      {
        target,
        field: 'highlights',
        value: {
          opportunities: parseCoordinates(
            editOpportunityHighlights,
            /^[a-h][1-8]$/,
          ),
          threats: parseCoordinates(
            editThreatHighlights,
            /^[a-h][1-8]$/,
          ),
        },
      },
    ];
    try {
      const saved = await Promise.all(
        inputs.map((input) => repository.setOverride(input)),
      );
      const savedIds = new Set(saved.map((item) => item.id));
      setLocal((current) => ({
        ...current,
        overrides: [
          ...current.overrides.filter((item) => !savedIds.has(item.id)),
          ...saved,
        ],
      }));
      setToast('Lokale Bearbeitung gespeichert');
      setEditorOpen(false);
    } catch {
      setStorageWarning('Die lokale Bearbeitung konnte nicht gespeichert werden.');
    }
  };

  const exportBackup = async () => {
    try {
      const backup = await exportLocalBackup({
        repository,
        storage: localStorage,
      });
      downloadLocalBackup(serializeLocalBackup(backup));
      setToast('Backup heruntergeladen');
    } catch (error) {
      setStorageWarning(
        error instanceof Error ? error.message : 'Backup fehlgeschlagen.',
      );
    }
  };

  const previewImportFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) {
      return;
    }
    setImportBusy(true);
    setStorageWarning(null);
    try {
      const preview = await parseBrowserImportFiles(
        files as BrowserImportFile[],
        { existingRepertoire: repertoire },
      );
      setImportPreview(preview);
      setImportLabel(
        files.length === 1
          ? files[0]?.name ?? '1 Datei'
          : `${files.length} Dateien`,
      );
    } catch (error) {
      setImportPreview(null);
      setStorageWarning(
        error instanceof Error ? error.message : 'Importprüfung fehlgeschlagen.',
      );
    } finally {
      setImportBusy(false);
    }
  };

  const applyImport = async () => {
    if (!importPreview?.canApply || !importPreview.payload) {
      return;
    }
    const confirmed = window.confirm(
      'Geprüften Import jetzt ausschließlich in der lokalen Benutzerebene anwenden?',
    );
    if (!confirmed) {
      return;
    }
    setImportBusy(true);
    setStorageWarning(null);
    try {
      if (importPreview.payload.kind === 'native-local-backup') {
        const backup = importPreview.payload.backup;
        let imported = false;
        try {
          await importLocalBackup(backup, {
            repository,
            storage: localStorage,
          });
          imported = true;
        } catch (error) {
          if (
            error instanceof LocalDataConflictError &&
            window.confirm(
              'Das Backup kollidiert mit vorhandenen lokalen Einträgen. Diese Einträge ausdrücklich überschreiben?',
            )
          ) {
            await importLocalBackup(backup, {
              repository,
              storage: localStorage,
              mode: 'overwrite',
            });
            imported = true;
          } else {
            throw error;
          }
        }
        if (imported) {
          const loaded = await refreshLocalData();
          setSettings(safeSettings());
          setSession(
            restoreNavigationState(
              loadNavigationState(),
              repertoire,
              loaded.selections,
              localAdditionsToBranches(loaded.additions),
            ),
          );
          setToast('Lokales Backup importiert');
        }
      } else {
        const additions = importPackageToLocalAdditions(
          importPreview,
          repertoire,
        );
        const existing = new Set(
          (await repository.listAdditions()).map((item) => item.id),
        );
        const collisions = additions.filter((item) => existing.has(item.id));
        let toSave = additions.filter((item) => !existing.has(item.id));
        if (
          collisions.length > 0 &&
          window.confirm(
            `${collisions.length} lokale Importeinträge sind bereits vorhanden. Diese ausdrücklich überschreiben?`,
          )
        ) {
          toSave = additions;
        }
        await Promise.all(toSave.map((addition) => repository.saveAddition(addition)));
        await refreshLocalData();
        setToast(
          `${toSave.length} lokale Repertoire-Ergänzungen importiert`,
        );
      }
      setImportPreview(null);
      setImportLabel(null);
    } catch (error) {
      try {
        await refreshLocalData();
      } catch {
        // Der ursprüngliche Importfehler bleibt die hilfreiche Meldung.
      }
      setStorageWarning(
        error instanceof Error ? error.message : 'Import fehlgeschlagen.',
      );
    } finally {
      setImportBusy(false);
    }
  };

  const resetEverything = async () => {
    const confirmed = window.confirm(
      'Alle lokalen Bearbeitungen, Ergänzungen, Einstellungen und Auswahlentscheidungen löschen?',
    );
    if (!confirmed) {
      return;
    }
    try {
      await resetLocalData({
        confirmed,
        repository,
        storage: localStorage,
      });
      setLocal(EMPTY_LOCAL_STATE);
      setSettings({ ...DEFAULT_APP_SETTINGS });
      setSession(restartSession());
      setToast('Lokale Daten zurückgesetzt');
    } catch (error) {
      setStorageWarning(
        error instanceof Error ? error.message : 'Zurücksetzen fehlgeschlagen.',
      );
    }
  };

  const copyFen = () => {
    void copyText(session.fullFen)
      .then(() => setToast('FEN kopiert'))
      .catch((error: unknown) =>
        setStorageWarning(
          error instanceof Error ? error.message : 'Kopieren fehlgeschlagen.',
        ),
      );
  };
  const copyPgn = () => {
    void copyText(sessionPgn(session))
      .then(() => setToast('PGN kopiert'))
      .catch((error: unknown) =>
        setStorageWarning(
          error instanceof Error ? error.message : 'Kopieren fehlgeschlagen.',
        ),
      );
  };

  const currentNode = repertoire.whiteTurnNodes[session.currentPosition];
  const allowedMoves = [
    ...new Set([
      ...(currentNode?.moves.map((move) => move.san) ?? []),
      ...localBranches
        .filter((branch) => branch.startPosition === session.currentPosition)
        .map((branch) => branch.whiteSan),
    ]),
  ].sort((left, right) => left.localeCompare(right, 'en'));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ♜
          </span>
          <div>
            <p>INTERACTIVE</p>
            <strong>ChessBook</strong>
          </div>
        </div>
        <div className="course-meta">
          <span>{repertoire.title} · {repertoire.openingSide}</span>
          <span className="data-badge">
            {repertoire.summary.studies} Studies ·{' '}
            {repertoire.summary.activeWhiteDecisions} lines
          </span>
        </div>
      </header>

      <main className="workspace">
        <section className="board-column">
          <div className="board-frame">
            <div className="board-status">
              <span className={`status-dot ${session.status}`} />
              <span>{statusLabel(session)}</span>
            </div>
            <RepertoireBoard
              fen={session.fullFen}
              orientation={settings.orientation}
              allowWhiteInput={hydrated && session.status === 'ready'}
              waiting={session.status === 'waiting'}
              onWhiteMove={handleWhiteMove}
              annotations={boardAnnotations}
              showArrows={settings.showArrows}
              showHighlights={settings.showHighlights}
            />
          </div>

          <nav className="toolbar" aria-label="Brettwerkzeuge">
            <button type="button" onClick={() => setSession(restartSession())}>
              ↺ <span>Neustart</span>
            </button>
            <button
              type="button"
              disabled={!session.pending && session.historyIndex === 0}
              onClick={() => setSession((current) => undoFullMove(current))}
            >
              ← <span>Zurück</span>
            </button>
            <button
              type="button"
              disabled={
                Boolean(session.pending) ||
                session.historyIndex >= session.history.length
              }
              onClick={() => setSession((current) => forwardFullMove(current))}
            >
              → <span>Vor</span>
            </button>
            <button
              type="button"
              onClick={() =>
                updateSetting({
                  orientation:
                    settings.orientation === 'black' ? 'white' : 'black',
                })
              }
            >
              ⇅ <span>Drehen</span>
            </button>
            <button
              type="button"
              aria-pressed={settings.showArrows}
              onClick={() =>
                updateSetting({ showArrows: !settings.showArrows })
              }
            >
              ↗ <span>Pfeile</span>
            </button>
            <button
              type="button"
              aria-pressed={settings.showHighlights}
              onClick={() =>
                updateSetting({ showHighlights: !settings.showHighlights })
              }
            >
              ◫ <span>Felder</span>
            </button>
          </nav>

          <section className="line-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Aktuelle Linie</p>
                <h2>Zugfolge</h2>
              </div>
              <div className="copy-actions">
                <button type="button" onClick={copyFen}>
                  FEN
                </button>
                <button type="button" onClick={copyPgn}>
                  PGN
                </button>
              </div>
            </div>
            <MoveList sans={currentLineSans(session)} />
            {allowedMoves.length > 0 && session.status === 'ready' ? (
              <div className="known-moves">
                <span>Im Buch:</span>
                {allowedMoves.map((move) => (
                  <code key={move}>{move}</code>
                ))}
              </div>
            ) : null}
          </section>
        </section>

        <aside className="book-panel">
          <div className="book-panel-header">
            <div>
              <p className="eyebrow">Digitales Eröffnungsbuch</p>
              <h1>Die Stellung verstehen</h1>
            </div>
            <div className="panel-actions">
              <button
                type="button"
                disabled={!targetId}
                onClick={() => setEditorOpen((value) => !value)}
              >
                ✎ Bearbeiten
              </button>
              <button
                type="button"
                onClick={() => setDataPanelOpen((value) => !value)}
              >
                ⤓ Daten
              </button>
            </div>
          </div>

          {storageWarning ? (
            <div className="notice warning" role="alert">
              {storageWarning}
              <button type="button" onClick={() => setStorageWarning(null)}>
                ×
              </button>
            </div>
          ) : null}

          {session.message ? (
            <div className={`notice ${session.status}`} role="status">
              {session.message}
            </div>
          ) : null}

          {session.status === 'conflict' && session.pending ? (
            <section className="decision-card">
              <p className="eyebrow">Bewusste Auswahl</p>
              <h2>Welche schwarze Antwort soll Standard sein?</h2>
              <div className="candidate-list">
                {session.pending.option?.candidates.map((candidate) => {
                  const studies = [
                    ...new Set(
                      candidateOrigins(repertoire, candidate).map(
                        (origin) => origin.studyFolder,
                      ),
                    ),
                  ];
                  return (
                    <button
                      type="button"
                      key={candidate.id}
                      onClick={() => void selectBaseCandidate(candidate.id)}
                    >
                      <strong>…{candidate.san}</strong>
                      <span>{studies.join(', ')}</span>
                    </button>
                  );
                })}
                {session.pending.localBranches.map((branch) => (
                  <button
                    type="button"
                    key={branch.id}
                    onClick={() => void selectLocalCandidate(branch.id)}
                  >
                    <strong>…{branch.blackSan}</strong>
                    <span>
                      {branch.sourceType === 'user'
                        ? 'Lokale Ergänzung'
                        : `Import · ${branch.sourceType}`}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {session.pending &&
          ['unknown', 'missing-reply', 'conflict'].includes(session.status) ? (
            <form className="editor-card branch-editor" onSubmit={addLocalBranch}>
              <p className="eyebrow">Lokale Ergänzung</p>
              <h2>Ast manuell ergänzen</h2>
              <label>
                Schwarze Antwort in SAN
                <input
                  required
                  placeholder="z. B. c6 oder Nf6"
                  value={manualSan}
                  onChange={(event) => setManualSan(event.target.value)}
                />
              </label>
              <label>
                Erklärung
                <textarea
                  value={manualExplanation}
                  onChange={(event) =>
                    setManualExplanation(event.target.value)
                  }
                />
              </label>
              <label>
                Pläne
                <textarea
                  value={manualPlans}
                  onChange={(event) => setManualPlans(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={() =>
                    setSession((current) => undoFullMove(current))
                  }
                >
                  Zug zurücknehmen
                </button>
                <button type="submit" className="primary">
                  Lokal speichern
                </button>
              </div>
            </form>
          ) : null}

          {dataPanelOpen ? (
            <section className="editor-card data-panel">
              <p className="eyebrow">Lokale Daten</p>
              <h2>Backups & Import</h2>
              <p>
                Basisrepertoire und Chessly-Rohdaten bleiben unverändert. Importe
                landen ausschließlich in der lokalen Benutzerebene.
              </p>
              <div className="data-actions">
                <button type="button" onClick={() => void exportBackup()}>
                  Backup herunterladen
                </button>
                <button
                  type="button"
                  disabled={importBusy}
                  onClick={() => importInputRef.current?.click()}
                >
                  JSON / ZIP / Dateien
                </button>
                <button
                  type="button"
                  disabled={importBusy}
                  onClick={() => directoryInputRef.current?.click()}
                >
                  Study-Ordner
                </button>
                <button type="button" className="danger" onClick={() => void resetEverything()}>
                  Lokale Daten zurücksetzen
                </button>
              </div>
              <input
                hidden
                ref={importInputRef}
                type="file"
                multiple
                accept="application/json,application/zip,.json,.md,.zip"
                onChange={(event) => void previewImportFiles(event)}
              />
              <input
                hidden
                ref={(element) => {
                  directoryInputRef.current = element;
                  element?.setAttribute('webkitdirectory', '');
                }}
                type="file"
                multiple
                onChange={(event) => void previewImportFiles(event)}
              />
              {importBusy ? (
                <p className="import-progress" role="status">
                  Import wird geprüft …
                </p>
              ) : null}
              {importPreview ? (
                <section className="import-preview" aria-label="Importvorschau">
                  <div className="import-preview-heading">
                    <div>
                      <p className="eyebrow">Importvorschau</p>
                      <strong>{importLabel}</strong>
                    </div>
                    <span className={`preview-status ${importPreview.status}`}>
                      {importPreview.status === 'ready'
                        ? 'bereit'
                        : 'ungültig'}
                    </span>
                  </div>
                  <dl className="import-stats">
                    <div>
                      <dt>Positionen</dt>
                      <dd>{importPreview.statistics.addedPositions}</dd>
                    </div>
                    <div>
                      <dt>Züge</dt>
                      <dd>{importPreview.statistics.addedMoves}</dd>
                    </div>
                    <div>
                      <dt>Kommentare</dt>
                      <dd>{importPreview.statistics.addedComments}</dd>
                    </div>
                    <div>
                      <dt>Duplikate</dt>
                      <dd>{importPreview.statistics.duplicates}</dd>
                    </div>
                    <div>
                      <dt>Konflikte</dt>
                      <dd>{importPreview.statistics.conflicts}</dd>
                    </div>
                    <div>
                      <dt>Ungültig</dt>
                      <dd>{importPreview.statistics.invalidFiles}</dd>
                    </div>
                    <div>
                      <dt>Graphteile</dt>
                      <dd>{importPreview.statistics.disconnectedGraphParts}</dd>
                    </div>
                    <div>
                      <dt>Isolierte Positionen</dt>
                      <dd>{importPreview.statistics.disconnectedPositions}</dd>
                    </div>
                  </dl>
                  {importPreview.issues.length > 0 ? (
                    <ul className="import-issues">
                      {importPreview.issues.slice(0, 12).map((issue, index) => (
                        <li
                          key={`${issue.code}-${issue.path}-${issue.location ?? ''}-${index}`}
                          className={issue.severity}
                        >
                          <strong>{issue.code}</strong>
                          <span>{issue.path}</span>
                          <p>{issue.message}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="import-clean">
                      Validierung ohne Datei- oder Graphfehler abgeschlossen.
                    </p>
                  )}
                  <p className="import-policy">
                    Priorität: Hauptkurs vor Bonus; lokale User-Antworten bleiben
                    eine getrennte Ebene. Es wird nichts ungefragt überschrieben.
                  </p>
                  <div className="form-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setImportPreview(null);
                        setImportLabel(null);
                      }}
                    >
                      Verwerfen
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!importPreview.canApply || importBusy}
                      onClick={() => void applyImport()}
                    >
                      Geprüften Import anwenden
                    </button>
                  </div>
                </section>
              ) : null}
              <dl className="local-stats">
                <div>
                  <dt>Overrides</dt>
                  <dd>{local.overrides.length}</dd>
                </div>
                <div>
                  <dt>Ergänzungen</dt>
                  <dd>{local.additions.length}</dd>
                </div>
                <div>
                  <dt>Antwortwahlen</dt>
                  <dd>{Object.keys(local.selections).length}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          {editorOpen && targetId ? (
            <form className="editor-card" onSubmit={saveEdits}>
              <p className="eyebrow">Lokaler Bearbeitungsmodus</p>
              <h2>Diese Buchseite anpassen</h2>
              <label>
                Warum dieser Zug?
                <textarea
                  value={editExplanation}
                  onChange={(event) => setEditExplanation(event.target.value)}
                />
              </label>
              <label>
                Pläne aus dieser Stellung
                <textarea
                  value={editPlans}
                  onChange={(event) => setEditPlans(event.target.value)}
                />
              </label>
              <div className="form-grid">
                <label>
                  Grüne Pfeile
                  <input
                    placeholder="f7-f6, c6-a5"
                    value={editOpportunityArrows}
                    onChange={(event) =>
                      setEditOpportunityArrows(event.target.value)
                    }
                  />
                </label>
                <label>
                  Rote Pfeile
                  <input
                    placeholder="c5-f2"
                    value={editThreatArrows}
                    onChange={(event) =>
                      setEditThreatArrows(event.target.value)
                    }
                  />
                </label>
                <label>
                  Grüne Felder
                  <input
                    placeholder="d4, e8"
                    value={editOpportunityHighlights}
                    onChange={(event) =>
                      setEditOpportunityHighlights(event.target.value)
                    }
                  />
                </label>
                <label>
                  Rote Felder
                  <input
                    placeholder="b2, d4"
                    value={editThreatHighlights}
                    onChange={(event) =>
                      setEditThreatHighlights(event.target.value)
                    }
                  />
                </label>
              </div>
              <div className="form-actions">
                <button type="button" onClick={() => setEditorOpen(false)}>
                  Abbrechen
                </button>
                <button type="submit" className="primary">
                  Lokal speichern
                </button>
              </div>
            </form>
          ) : null}

          {session.response ? (
            <>
              <section className="move-answer">
                <div>
                  <span>Weiß spielte</span>
                  <strong>{session.response.whiteSan}</strong>
                </div>
                <span className="answer-arrow">→</span>
                <div>
                  <span>Schwarz antwortet</span>
                  <strong>…{session.response.blackSan}</strong>
                </div>
              </section>
              <AnnotationSection
                eyebrow="Antworterklärung"
                title="Warum dieser Zug?"
                annotations={baseContent.explanations}
                overrideText={effectiveExplanation}
                emptyText="Für diese Antwort ist keine separate Erklärung gespeichert."
              />
              <AnnotationSection
                eyebrow="Resultierende Stellung"
                title="Pläne aus dieser Stellung"
                annotations={baseContent.plans}
                overrideText={effectivePlans}
                emptyText="Für diese Endstellung ist keine separate Chessly-Notiz gespeichert."
              />
              <StrategicIdeas
                previousAnnotations={baseContent.explanations}
                currentAnnotations={baseContent.plans}
                arrowOverride={
                  arrowOverride !== undefined
                    ? arrowOverride
                    : localBranch?.resultingArrows
                }
                highlightOverride={
                  highlightOverride !== undefined
                    ? highlightOverride
                    : localBranch?.resultingHighlights
                }
                previousArrowOverride={localBranch?.replyArrows}
                previousHighlightOverride={localBranch?.replyHighlights}
              />
            </>
          ) : (
            <section className="welcome-page">
              <p className="eyebrow">Kapitel 1 · Der Einstieg</p>
              <h2>Du führst die weißen Figuren.</h2>
              <p>
                Spiele einen legalen weißen Zug. Das Buch antwortet nach einem
                kurzen Augenblick ausschließlich mit dem gespeicherten
                Caro-Kann-Repertoire—ohne Engine und ohne Bewertung.
              </p>
              <div className="opening-prompt">
                <span>Empfohlener Start</span>
                <strong>1. e4</strong>
                <small>Schwarz antwortet mit …c6</small>
              </div>
            </section>
          )}
        </aside>
      </main>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

type OpeningSideFilter = 'all' | 'white' | 'black';
type OpeningSort = 'alphabetical' | 'studies' | 'positions';
type LibraryFilter = OpeningSideFilter | 'combined';

function normalizedOpeningSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '');
}

function compareOpeningTitles(
  left: OpeningIndexEntry,
  right: OpeningIndexEntry,
): number {
  return left.title.localeCompare(right.title, 'en', { sensitivity: 'base' });
}

export default function App() {
  const [openings, setOpenings] = useState<OpeningIndexEntry[] | null>(null);
  const [selected, setSelected] = useState<OpeningIndexEntry | null>(null);
  const [selectedCombined, setSelectedCombined] = useState<CombinedOpening | null>(null);
  const [selectedPgn, setSelectedPgn] = useState<ImportedPgn | null>(null);
  const [selectedMode, setSelectedMode] =
    useState<OpeningWorkspaceMode>('book');
  const [repertoire, setRepertoire] =
    useState<CanonicalRepertoire | null>(null);
  const [popularityPack, setPopularityPack] =
    useState<PopularityPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [sort, setSort] = useState<OpeningSort>('alphabetical');
  const [importedPgns, setImportedPgns] = useState<ImportedPgn[]>([]);
  const userState = useMemo(() => new UserStateStore(), []);
  const [favorites, setFavorites] = useState<string[]>(() => userState.getFavorites());
  const [pgnText, setPgnText] = useState('');
  const [pgnError, setPgnError] = useState<string | null>(null);
  const [explorerSources, setExplorerSources] = useState<ExplorerSource[] | null>(null);
  const [courseImportSide, setCourseImportSide] =
    useState<'white' | 'black'>('white');
  const [courseImportBusy, setCourseImportBusy] = useState(false);
  const [courseImportError, setCourseImportError] = useState<string | null>(null);
  const [courseImportNotice, setCourseImportNotice] = useState<string | null>(null);
  const coursePacks = useMemo(() => new CoursePackRepository(), []);
  const repertoireCache = useRef(new Map<string, CanonicalRepertoire>());
  const pgnFileRef = useRef<HTMLInputElement>(null);
  const courseZipRef = useRef<HTMLInputElement>(null);
  const courseDirectoryRef = useRef<HTMLInputElement>(null);

  const combinedOpenings = useMemo(
    () => createCombinedOpenings(openings ?? []),
    [openings],
  );

  const filterCounts = useMemo(
    () => ({
      all: (openings?.length ?? 0) + combinedOpenings.length,
      white:
        openings?.filter((opening) => opening.repertoireSide === 'white')
          .length ?? 0,
      black:
        openings?.filter((opening) => opening.repertoireSide === 'black')
          .length ?? 0,
      combined: combinedOpenings.length,
    }),
    [combinedOpenings.length, openings],
  );

  const visibleOpenings = useMemo(() => {
    if (!openings) {
      return [];
    }
    const normalizedSearch = normalizedOpeningSearch(search);
    if (libraryFilter === 'combined') return [];
    const result = openings.filter(
      (opening) =>
        (libraryFilter === 'all' || opening.repertoireSide === libraryFilter) &&
        (normalizedSearch === '' ||
          normalizedOpeningSearch(opening.title).includes(normalizedSearch) ||
          normalizedOpeningSearch(opening.slug ?? '').includes(
            normalizedSearch,
          )),
    );
    return [...result].sort((left, right) => {
      if (sort === 'studies') {
        return (
          right.studies - left.studies || compareOpeningTitles(left, right)
        );
      }
      if (sort === 'positions') {
        return (
          right.positions - left.positions || compareOpeningTitles(left, right)
        );
      }
      return compareOpeningTitles(left, right);
    });
  }, [libraryFilter, openings, search, sort]);

  const normalizedSearch = normalizedOpeningSearch(search);
  const visibleCombined = useMemo(() => {
    return combinedOpenings.filter((opening) =>
      (libraryFilter === 'all' || libraryFilter === 'combined' || opening.repertoireSide === libraryFilter) &&
      (normalizedSearch === '' || normalizedOpeningSearch(opening.title).includes(normalizedSearch)),
    );
  }, [combinedOpenings, libraryFilter, normalizedSearch]);
  const visiblePgns = useMemo(() => {
    if (libraryFilter !== 'all') return [];
    return importedPgns.filter((game) =>
      normalizedSearch === '' || normalizedOpeningSearch(game.name).includes(normalizedSearch),
    );
  }, [importedPgns, libraryFilter, normalizedSearch]);

  const openOpening = (
    opening: OpeningIndexEntry,
    mode: OpeningWorkspaceMode,
  ): void => {
    setSelectedCombined(null);
    setSelectedPgn(null);
    setExplorerSources(null);
    setRepertoire(repertoireCache.current.get(opening.processedFile) ?? null);
    setSelectedMode(mode);
    setSelected(opening);
  };

  const openCombined = (opening: CombinedOpening, mode: OpeningWorkspaceMode): void => {
    setError(null);
    setSelected(null);
    setSelectedPgn(null);
    setSelectedCombined(opening);
    setSelectedMode(mode);
    setExplorerSources(null);
  };

  const openPgn = (game: ImportedPgn): void => {
    setError(null);
    setSelected(null);
    setSelectedCombined(null);
    setSelectedPgn(game);
    setExplorerSources(null);
  };

  const returnToLibrary = (): void => {
    setSelected(null);
    setSelectedCombined(null);
    setSelectedPgn(null);
    setExplorerSources(null);
    setRepertoire(null);
    setPopularityPack(null);
    setError(null);
  };

  const addPgn = (text: string, filename?: string): void => {
    try {
      const game = parsePgn(text, filename);
      setImportedPgns((current) => [game, ...current.filter((item) => item.id !== game.id)]);
      setPgnText('');
      setPgnError(null);
      setLibraryFilter('all');
    } catch (reason) {
      setPgnError(reason instanceof Error ? reason.message : 'The PGN could not be imported.');
    }
  };

  const toggleFavorite = (id: string): void => {
    setFavorites(userState.setFavorite(id, !favorites.includes(id)));
  };

  const importCourse = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])] as BrowserImportFile[];
    event.target.value = '';
    if (files.length === 0) return;
    setCourseImportBusy(true);
    setCourseImportError(null);
    setCourseImportNotice(null);
    try {
      const packs = await buildCoursePacksFromBrowserFiles(
        files,
        courseImportSide,
      );
      for (const pack of packs) {
        await coursePacks.save(pack.index, pack.repertoire);
        repertoireCache.current.set(pack.index.processedFile, pack.repertoire);
      }
      const importedIds = new Set(packs.map((pack) => pack.index.id));
      setOpenings((current) => [
        ...(current ?? []).filter((opening) => !importedIds.has(opening.id)),
        ...packs.map((pack) => pack.index),
      ].sort(compareOpeningTitles));
      setCourseImportNotice(
        packs.length === 1
          ? `${packs[0]?.index.title} wurde nur auf diesem Gerät gespeichert.`
          : `${packs.length} Kurse wurden nur auf diesem Gerät gespeichert.`,
      );
      setSearch('');
      setLibraryFilter('all');
    } catch (reason) {
      setCourseImportError(
        reason instanceof Error
          ? reason.message
          : 'Der Kurs konnte nicht importiert werden.',
      );
    } finally {
      setCourseImportBusy(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadOpeningIndex(controller.signal)
      .then(setOpenings)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error
              ? reason.message
              : ENGLISH.libraryError,
          );
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected) {
      setRepertoire(null);
      return;
    }
    const cachedRepertoire = repertoireCache.current.get(
      selected.processedFile,
    );
    if (cachedRepertoire) {
      setError(null);
      setRepertoire(cachedRepertoire);
      return;
    }
    const controller = new AbortController();
    setError(null);
    void loadRepertoire(selected.processedFile, controller.signal)
      .then((loadedRepertoire) => {
        if (!controller.signal.aborted) {
          repertoireCache.current.set(
            selected.processedFile,
            loadedRepertoire,
          );
          setRepertoire(loadedRepertoire);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : ENGLISH.openingError);
        }
      });
    return () => controller.abort();
  }, [selected]);

  useEffect(() => {
    const openingId = selected?.id ?? selectedCombined?.id;
    setPopularityPack(null);
    if (!openingId) return;
    const controller = new AbortController();
    void loadPopularityPack(openingId, controller.signal)
      .then((pack) => {
        if (!controller.signal.aborted) setPopularityPack(pack);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPopularityPack(null);
      });
    return () => controller.abort();
  }, [selected, selectedCombined]);

  useEffect(() => {
    const selectionIds = selectedCombined?.openingIds ??
      (selectedPgn ? openings?.map((opening) => opening.id) : null);
    if (!selectionIds || !openings) return;
    const entries = selectionIds.flatMap((id) => {
      const entry = openings.find((opening) => opening.id === id);
      return entry ? [entry] : [];
    });
    const controller = new AbortController();
    setExplorerSources(null);
    void Promise.all(entries.map(async (entry) => {
      const cached = repertoireCache.current.get(entry.processedFile);
      const graph = cached ?? await loadRepertoire(entry.processedFile, controller.signal);
      repertoireCache.current.set(entry.processedFile, graph);
      return {
        openingId: entry.id,
        title: entry.title,
        repertoireSide: entry.repertoireSide,
        repertoire: graph,
      } satisfies ExplorerSource;
    })).then((sources) => {
      if (!controller.signal.aborted) setExplorerSources(sources);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : ENGLISH.openingError);
      }
    });
    return () => controller.abort();
  }, [openings, selectedCombined, selectedPgn]);

  useEffect(() => {
    if (selected || selectedCombined || selectedPgn) return;
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
      const controls = [...document.querySelectorAll<HTMLElement>('.opening-card button:not(:disabled)')];
      if (controls.length === 0) return;
      const current = Math.max(0, controls.indexOf(document.activeElement as HTMLElement));
      const step = event.shiftKey ? 2 : 1;
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(controls.length - 1, current + step);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, current - step);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = controls.length - 1;
      if (next !== null) { event.preventDefault(); controls[next]?.focus(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [selected, selectedCombined, selectedPgn]);

  const bestPgnSource = useMemo(() => {
    if (!selectedPgn || !explorerSources?.length) return null;
    return explorerSources.reduce<{ source: ExplorerSource; plies: number } | null>((best, source) => {
      const plies = analyzePgn(selectedPgn, createExplorerIndex([source])).theoryPlies;
      return !best || plies > best.plies ? { source, plies } : best;
    }, null)?.source ?? null;
  }, [explorerSources, selectedPgn]);
  const combinedRepertoire = useMemo(() => {
    if (!selectedCombined || !explorerSources || selectedMode === 'explorer') return null;
    return combineRepertoires(
      selectedCombined,
      explorerSources.map((source) => source.repertoire),
    );
  }, [explorerSources, selectedCombined, selectedMode]);

  const favoriteOpenings = normalizedSearch === ''
    ? visibleOpenings.filter((opening) => favorites.includes(opening.id))
    : [];
  const favoriteCombined = normalizedSearch === ''
    ? visibleCombined.filter((opening) => favorites.includes(opening.id))
    : [];
  const libraryOpenings = normalizedSearch === ''
    ? visibleOpenings.filter((opening) => !favorites.includes(opening.id))
    : visibleOpenings;
  const libraryCombined = normalizedSearch === ''
    ? visibleCombined.filter((opening) => !favorites.includes(opening.id))
    : visibleCombined;

  const openingCard = (opening: OpeningIndexEntry) => (
    <article className="opening-card" key={opening.id}>
      <div className="opening-card-title">
        <h2>{opening.title}</h2>
        <span>{opening.repertoireSide}</span>
        <button className="favorite-button" type="button" aria-label={`${favorites.includes(opening.id) ? 'Remove' : 'Add'} ${opening.title} ${favorites.includes(opening.id) ? 'from' : 'to'} favorites`} aria-pressed={favorites.includes(opening.id)} onClick={() => toggleFavorite(opening.id)}>{favorites.includes(opening.id) ? '★' : '☆'}</button>
      </div>
      <dl>
        <div><dt>{ENGLISH.studies}</dt><dd>{opening.studies}</dd></div>
        <div><dt>{ENGLISH.decisions}</dt><dd>{opening.repertoireDecisions}</dd></div>
        <div><dt>{ENGLISH.maximumDepth}</dt><dd>{opening.maximumDepth}</dd></div>
        <div><dt>{ENGLISH.dataStatus}</dt><dd>{opening.validationStatus}</dd></div>
      </dl>
      <div className="card-actions">
        <button type="button" className="primary" disabled={!opening.availableModes.includes('book')} aria-label={`Open ${opening.title} in Book Mode`} onClick={() => openOpening(opening, 'book')}>Book</button>
        <button type="button" disabled={!opening.availableModes.includes('practice')} aria-label={`Practice ${opening.title} in Practice Mode`} onClick={() => openOpening(opening, 'practice')}>Practice</button>
        <button type="button" disabled={!opening.availableModes.includes('explorer')} aria-label={`Explore ${opening.title} in Explorer`} onClick={() => openOpening(opening, 'explorer')}>Explorer</button>
      </div>
    </article>
  );

  const combinedCard = (opening: CombinedOpening) => (
    <article className="opening-card" key={opening.id}>
      <div className="opening-card-title">
        <h2>{opening.title}</h2><span>{opening.repertoireSide}</span><span className="combined-badge">COMBINED</span>
        <button className="favorite-button" type="button" aria-label={`${favorites.includes(opening.id) ? 'Remove' : 'Add'} ${opening.title} ${favorites.includes(opening.id) ? 'from' : 'to'} favorites`} aria-pressed={favorites.includes(opening.id)} onClick={() => toggleFavorite(opening.id)}>{favorites.includes(opening.id) ? '★' : '☆'}</button>
      </div>
      <dl><div><dt>Sources</dt><dd>{opening.openingIds.length}</dd></div><div><dt>Storage</dt><dd>References only</dd></div></dl>
      <div className="card-actions">
        {opening.availableModes.includes('book') ? <button type="button" className="primary" aria-label={`Open ${opening.title} in Book Mode`} onClick={() => openCombined(opening, 'book')}>Book</button> : null}
        {opening.availableModes.includes('practice') ? <button type="button" aria-label={`Practice ${opening.title} in Practice Mode`} onClick={() => openCombined(opening, 'practice')}>Practice</button> : null}
        <button type="button" aria-label={`Explore ${opening.title} in Explorer`} onClick={() => openCombined(opening, 'explorer')}>Explorer</button>
      </div>
    </article>
  );

  if (error) {
    return (
      <main className="loading-screen error-screen">
        <span>♜</span>
        <h1>{selected || selectedCombined || selectedPgn ? ENGLISH.openingError : ENGLISH.libraryError}</h1>
        <p>{error}</p>
        <button type="button" onClick={returnToLibrary}>
          {ENGLISH.backToLibrary}
        </button>
      </main>
    );
  }
  if (!openings) {
    return <LoadingScreen message={ENGLISH.loadingLibrary}/>;
  }
  if (!selected && !selectedCombined && !selectedPgn) {
    return (
      <main className="library-screen">
        <header className="library-header">
          <span className="brand-mark" aria-hidden="true">♜</span>
          <div>
            <p className="eyebrow">Interactive ChessBook</p>
            <h1>{ENGLISH.chooseOpening}</h1>
            <p>{ENGLISH.libraryIntro}</p>
          </div>
        </header>
        <section className="course-import" aria-label="Privaten Kurs importieren">
          <div>
            <p className="eyebrow">Private Kursbibliothek</p>
            <h2>Eigenen Chessly-Kurs hinzufügen</h2>
            <p>
              Einzelnen Kurs oder kompletten chessly-Ordner/ZIP wählen. Die
              Kurse bleiben ausschließlich im Browser auf diesem Gerät.
            </p>
          </div>
          <fieldset>
            <legend>Beim Import eines einzelnen Kurses spiele ich</legend>
            <button
              type="button"
              aria-pressed={courseImportSide === 'white'}
              onClick={() => setCourseImportSide('white')}
            >
              Weiß
            </button>
            <button
              type="button"
              aria-pressed={courseImportSide === 'black'}
              onClick={() => setCourseImportSide('black')}
            >
              Schwarz
            </button>
          </fieldset>
          <div className="course-import-actions">
            <button
              type="button"
              disabled={courseImportBusy}
              onClick={() => courseZipRef.current?.click()}
            >
              Kurs-ZIP wählen (einzeln/alle)
            </button>
            <button
              type="button"
              className="primary"
              disabled={courseImportBusy}
              onClick={() => courseDirectoryRef.current?.click()}
            >
              Kursordner wählen (einzeln/alle)
            </button>
          </div>
          <input
            hidden
            ref={courseZipRef}
            type="file"
            accept="application/zip,.zip"
            onChange={(event) => void importCourse(event)}
          />
          <input
            hidden
            ref={(element) => {
              courseDirectoryRef.current = element;
              element?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            onChange={(event) => void importCourse(event)}
          />
          {courseImportBusy ? (
            <p className="course-import-status" role="status">
              Kursdaten werden lokal geprüft und vorbereitet …
            </p>
          ) : null}
          {courseImportError ? (
            <p className="course-import-error" role="alert">
              {courseImportError}
            </p>
          ) : null}
          {courseImportNotice ? (
            <p className="course-import-success" role="status">
              {courseImportNotice}
            </p>
          ) : null}
        </section>
        <section className="library-controls" aria-label="Opening library controls">
          <label className="library-search">
            <span>Search openings</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setSearch('');
                }
              }}
              placeholder="Search by opening name"
              autoComplete="off"
            />
          </label>
          <fieldset className="library-filters">
            <legend>Openings</legend>
            {(['all', 'white', 'black', 'combined'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={libraryFilter === filter}
                onClick={() => setLibraryFilter(filter)}
              >
                {filter === 'all'
                  ? 'All'
                  : filter === 'white'
                    ? 'White'
                    : filter === 'black' ? 'Black' : 'Combined'}{' '}
                ({filterCounts[filter]})
              </button>
            ))}
          </fieldset>
          <label className="library-sort">
            <span>Sort openings</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as OpeningSort)}
            >
              <option value="alphabetical">Alphabetical</option>
              <option value="studies">Most studies</option>
              <option value="positions">Most positions</option>
            </select>
          </label>
        </section>
        <section className="pgn-import" aria-label="PGN import">
          <div><p className="eyebrow">PGN</p><h2>Import a game</h2><p>Paste PGN text or choose a .pgn file. Source repertoire data remains read-only.</p></div>
          <textarea aria-label="Paste PGN" value={pgnText} onChange={(event) => setPgnText(event.target.value)} placeholder="[Event &quot;My game&quot;]&#10;&#10;1. e4 ..." />
          <input ref={pgnFileRef} type="file" accept=".pgn,application/x-chess-pgn,text/plain" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.text().then((text) => addPgn(text, file.name));
            event.target.value = '';
          }} />
          <div className="pgn-import-actions">
            <button type="button" onClick={() => pgnFileRef.current?.click()}>Choose PGN file</button>
            <button type="button" className="primary" disabled={!pgnText.trim()} onClick={() => addPgn(pgnText)}>Import pasted PGN</button>
          </div>
          {pgnError ? <p role="alert">{pgnError}</p> : null}
        </section>
        {favoriteOpenings.length + favoriteCombined.length > 0 ? (
          <section aria-label="Favorites">
            <div className="library-section-heading"><p className="eyebrow">Favorites</p><h2>Favorites</h2></div>
            <div className="opening-grid">{favoriteOpenings.map(openingCard)}{favoriteCombined.map(combinedCard)}</div>
          </section>
        ) : null}
        {libraryOpenings.length > 0 ? (
          <section className="opening-grid" aria-label="Opening library">
            {libraryOpenings.map(openingCard)}
          </section>
        ) : null}
        {libraryCombined.length > 0 ? <section className="opening-grid" aria-label="Combined openings">
          {libraryCombined.map(combinedCard)}
        </section> : null}
        {visiblePgns.length > 0 ? <section className="opening-grid pgn-grid" aria-label="Imported PGN games">
          {visiblePgns.map((game) => <article className="opening-card pgn-card" key={game.id}>
            <div className="opening-card-title"><h2>{game.name}</h2><span>PGN</span></div>
            <dl><div><dt>Moves</dt><dd>{game.moves.length}</dd></div><div><dt>White</dt><dd>{game.headers.White ?? '—'}</dd></div><div><dt>Black</dt><dd>{game.headers.Black ?? '—'}</dd></div></dl>
            <button type="button" className="primary" onClick={() => openPgn(game)}>Analyze &amp; explore</button>
          </article>)}
        </section> : null}
        {visibleOpenings.length === 0 && visibleCombined.length === 0 && visiblePgns.length === 0 ? (
          <section className="library-empty" role="status">
            <h2>{openings.length === 0 ? 'Noch keine Kurse importiert' : 'No openings match your search'}</h2>
            <p>{openings.length === 0 ? 'Wähle oben einen eigenen Chessly-Kurs aus.' : 'Try a different search or repertoire-side filter.'}</p>
          </section>
        ) : null}
      </main>
    );
  }
  if (selectedCombined || selectedPgn) {
    if (!explorerSources) {
      return <LoadingScreen message="Loading referenced opening graphs lazily…"/>;
    }
    const bestOpening = bestPgnSource
      ? openings.find((opening) => opening.id === bestPgnSource.openingId) ?? null
      : null;
    if (selectedCombined && selectedMode !== 'explorer' && combinedRepertoire) {
      return <>
        <button className="library-back" type="button" onClick={returnToLibrary}>← {ENGLISH.backToLibrary}</button>
        <OpeningWorkspace repertoire={combinedRepertoire} popularityPack={popularityPack} initialMode={selectedMode} explorerSources={explorerSources} onExit={returnToLibrary} />
      </>;
    }
    return <>
      <button className="library-back" type="button" onClick={returnToLibrary}>← {ENGLISH.backToLibrary}</button>
      {selectedPgn && bestOpening ? <div className="pgn-mode-actions" aria-label="Imported game modes">
        <span>Best theory match: {bestOpening.title}</span>
        <button onClick={() => openOpening(bestOpening, 'book')}>Open matching Book</button>
        <button onClick={() => openOpening(bestOpening, 'practice')}>Practice matching opening</button>
      </div> : null}
      <ExplorerWorkspace
        title={selectedCombined?.title ?? selectedPgn?.name ?? 'Explorer'}
        sources={explorerSources}
        importedGame={selectedPgn}
        onExit={returnToLibrary}
      />
    </>;
  }
  if (!repertoire) {
    return <LoadingScreen message={ENGLISH.loadingOpening}/>;
  }
  return (
    <>
      <button className="library-back" type="button" onClick={returnToLibrary}>
        ← {ENGLISH.backToLibrary}
      </button>
      <OpeningWorkspace repertoire={repertoire} popularityPack={popularityPack} initialMode={selectedMode} onExit={returnToLibrary} />
    </>
  );
}
