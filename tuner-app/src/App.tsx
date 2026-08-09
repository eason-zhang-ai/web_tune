import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILT_IN_TUNINGS,
  IN_TUNE_CENTS,
  NOTE_OPTIONS,
  centsBetween,
  createTuning,
  detectPitchAutoCorrelation,
  median,
  normalizeCustomTuning,
  normalizeImportedTunings,
  portableTuning,
  selectAutomaticTarget,
} from "./tuner-core.mjs";

const CUSTOM_TUNINGS_KEY = "guitar-tuner.custom-tunings.v1";
const SELECTED_TUNING_KEY = "guitar-tuner.selected-tuning.v1";

type AudioStatus = "idle" | "listening" | "unsupported" | "denied" | "error";

type Reading = {
  frequency: number;
  cents: number;
  clarity: number;
} | null;

class TunerEngine {
  onReading: (reading: { frequency: number; clarity: number } | null) => void;
  context: AudioContext | null = null;
  stream: MediaStream | null = null;
  analyser: AnalyserNode | null = null;
  frame: number | null = null;
  lastRead = 0;
  samples: Float32Array | null = null;
  history: number[] = [];
  running = false;

  constructor(onReading: (reading: { frequency: number; clarity: number } | null) => void) {
    this.onReading = onReading;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      const error = new Error("unsupported");
      error.name = "NotSupportedError";
      throw error;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0;
    this.samples = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.running = true;
    this.loop();
  }

  loop = (timestamp = 0) => {
    if (!this.running || !this.analyser || !this.samples || !this.context) return;
    if (timestamp - this.lastRead > 72) {
      this.lastRead = timestamp;
      this.analyser.getFloatTimeDomainData(this.samples);
      const pitch = detectPitchAutoCorrelation(this.samples, this.context.sampleRate);
      if (pitch) {
        this.history.push(pitch.frequency);
        if (this.history.length > 5) this.history.shift();
        this.onReading({ frequency: median(this.history) ?? pitch.frequency, clarity: pitch.clarity });
      } else {
        this.history = [];
        this.onReading(null);
      }
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  stop() {
    this.running = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.context = null;
    this.stream = null;
    this.analyser = null;
    this.samples = null;
    this.history = [];
    this.onReading(null);
  }
}

function readCustomTunings() {
  try {
    const stored = JSON.parse(localStorage.getItem(CUSTOM_TUNINGS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.map(normalizeCustomTuning).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveCustomTunings(tunings) {
  localStorage.setItem(CUSTOM_TUNINGS_KEY, JSON.stringify(tunings));
}

function noteLabel(target) {
  return `${target.note}${target.octave}`;
}

function describeStatus(status: AudioStatus, reading: Reading) {
  if (status === "listening") return reading ? "正在聆听" : "等待弹响琴弦";
  if (status === "denied") return "未获得麦克风权限";
  if (status === "unsupported") return "当前浏览器不支持麦克风";
  if (status === "error") return "麦克风启动失败";
  return "尚未启动麦克风";
}

function githubRawUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("请使用 HTTPS GitHub 链接");
  if (url.hostname === "raw.githubusercontent.com" || url.hostname === "gist.githubusercontent.com") return url.href;
  if (url.hostname === "gist.github.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)$/);
    if (!match) throw new Error("请粘贴单文件 Gist 页面或 Gist Raw 链接");
    return `https://gist.githubusercontent.com/${match[1]}/${match[2]}/raw`;
  }
  if (url.hostname !== "github.com") throw new Error("仅支持 GitHub 或 GitHub Gist 链接");
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("请粘贴 GitHub 文件页（.../blob/...）或 Raw 链接");
  const [, owner, repository, branch, filePath] = match;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${filePath}`;
}

function customTuningId(existing: Array<{ id: string }>) {
  let sequence = 0;
  let id = `custom-${Date.now()}`;
  while (existing.some((item) => item.id === id)) {
    sequence += 1;
    id = `custom-${Date.now()}-${sequence}`;
  }
  return id;
}

export function App() {
  const [customTunings, setCustomTunings] = useState(() => readCustomTunings());
  const allTunings = useMemo(() => [...BUILT_IN_TUNINGS, ...customTunings], [customTunings]);
  const [selectedTuningId, setSelectedTuningId] = useState(() => localStorage.getItem(SELECTED_TUNING_KEY) ?? "standard");
  const activeTuning = allTunings.find((item) => item.id === selectedTuningId) ?? BUILT_IN_TUNINGS[0];
  const [selectedStringId, setSelectedStringId] = useState(activeTuning.strings[0].id);
  const [automatic, setAutomatic] = useState(true);
  const [status, setStatus] = useState<AudioStatus>("idle");
  const [reading, setReading] = useState<Reading>(null);
  const [showTuningPanel, setShowTuningPanel] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showImporter, setShowImporter] = useState(false);
  const [editingTuningId, setEditingTuningId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("我的调弦");
  const [draftStrings, setDraftStrings] = useState(() => activeTuning.strings.map(({ note, octave }) => ({ note, octave })));
  const [importUrl, setImportUrl] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const engineRef = useRef<TunerEngine | null>(null);
  const tuningRef = useRef(activeTuning);
  const automaticRef = useRef(automatic);
  const selectedStringRef = useRef(selectedStringId);

  useEffect(() => {
    tuningRef.current = activeTuning;
    localStorage.setItem(SELECTED_TUNING_KEY, activeTuning.id);
    const isCurrentStringValid = activeTuning.strings.some((item) => item.id === selectedStringRef.current);
    if (!isCurrentStringValid) {
      setSelectedStringId(activeTuning.strings[0].id);
      selectedStringRef.current = activeTuning.strings[0].id;
    }
  }, [activeTuning]);

  useEffect(() => {
    automaticRef.current = automatic;
  }, [automatic]);

  useEffect(() => () => engineRef.current?.stop(), []);

  const onPitch = useCallback((pitch: { frequency: number; clarity: number } | null) => {
    if (!pitch) {
      setReading(null);
      return;
    }
    const tuning = tuningRef.current;
    const target = automaticRef.current
      ? selectAutomaticTarget(tuning, pitch.frequency, selectedStringRef.current)
      : tuning.strings.find((item) => item.id === selectedStringRef.current) ?? tuning.strings[0];
    if (target.id !== selectedStringRef.current) {
      selectedStringRef.current = target.id;
      setSelectedStringId(target.id);
    }
    setReading({
      frequency: pitch.frequency,
      cents: centsBetween(pitch.frequency, target.frequency),
      clarity: pitch.clarity,
    });
  }, []);

  const startListening = useCallback(async () => {
    engineRef.current?.stop();
    const engine = new TunerEngine(onPitch);
    engineRef.current = engine;
    try {
      await engine.start();
      setStatus("listening");
    } catch (error) {
      engine.stop();
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        setStatus("denied");
      } else if (error instanceof Error && error.name === "NotSupportedError") {
        setStatus("unsupported");
      } else {
        setStatus("error");
      }
    }
  }, [onPitch]);

  const stopListening = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    setReading(null);
    setStatus("idle");
  }, []);

  const chooseString = (id) => {
    setAutomatic(false);
    automaticRef.current = false;
    selectedStringRef.current = id;
    setSelectedStringId(id);
    setReading(null);
  };

  const chooseTuning = (id) => {
    setSelectedTuningId(id);
    setAutomatic(true);
    setReading(null);
    setShowTuningPanel(false);
  };

  const startNewDraft = () => {
    setEditingTuningId(null);
    setDraftName("我的调弦");
    setDraftStrings(activeTuning.strings.map(({ note, octave }) => ({ note, octave })));
    setShowEditor(true);
  };

  const editDraft = (tuning) => {
    setEditingTuningId(tuning.id);
    setDraftName(tuning.name);
    setDraftStrings(tuning.strings.map(({ note, octave }) => ({ note, octave })));
    setShowEditor(true);
  };

  const saveDraft = () => {
    const name = draftName.trim() || "我的调弦";
    const id = editingTuningId ?? customTuningId(customTunings);
    const tuning = createTuning(id, name, draftStrings.map((item) => [item.note, Number(item.octave)]), "custom");
    const next = editingTuningId
      ? customTunings.map((item) => item.id === editingTuningId ? tuning : item)
      : [...customTunings, tuning];
    setCustomTunings(next);
    saveCustomTunings(next);
    setSelectedTuningId(tuning.id);
    setShowEditor(false);
    setShowTuningPanel(false);
    setAutomatic(true);
  };

  const exportCustomTuning = (tuning) => {
    const blob = new Blob([`${JSON.stringify(portableTuning(tuning), null, 2)}\n`], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const filename = tuning.name.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/(^-|-$)/g, "") || "custom-tuning";
    link.href = objectUrl;
    link.download = `${filename}.web-tune.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  const openImporter = () => {
    setImportMessage("");
    setShowTuningPanel(false);
    setShowImporter(true);
  };

  const importFromGitHub = async () => {
    setImportMessage("");
    setIsImporting(true);
    try {
      const response = await fetch(githubRawUrl(importUrl), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
      const payload = await response.json();
      const imported = normalizeImportedTunings(payload);
      if (!imported.length) throw new Error("配置需要包含名称和 6 根有效琴弦");
      const added = imported.reduce((items, item) => {
        items.push(createTuning(
          customTuningId([...customTunings, ...items]),
          item.name,
          item.strings.map(({ note, octave }) => [note, octave]),
          "custom",
        ));
        return items;
      }, []);
      const next = [...customTunings, ...added];
      setCustomTunings(next);
      saveCustomTunings(next);
      setSelectedTuningId(added[0].id);
      setAutomatic(true);
      setImportMessage(`已导入 ${added.length} 个调弦方案，并保存到本机。`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "导入失败，请检查链接和 JSON 配置");
    } finally {
      setIsImporting(false);
    }
  };

  const removeCustomTuning = (id) => {
    const next = customTunings.filter((item) => item.id !== id);
    setCustomTunings(next);
    saveCustomTunings(next);
    if (id === selectedTuningId) setSelectedTuningId("standard");
  };

  const selectedTarget = activeTuning.strings.find((item) => item.id === selectedStringId) ?? activeTuning.strings[0];
  const cents = reading?.cents ?? 0;
  const inTune = Boolean(reading && Math.abs(cents) <= IN_TUNE_CENTS);
  const direction = !reading ? "" : inTune ? "已调准" : cents < 0 ? "偏低 · 调紧一点" : "偏高 · 放松一点";
  const needleRotation = Math.max(-42, Math.min(42, cents * 0.84));
  const leftStrings = activeTuning.strings.slice(0, 3).reverse();
  const rightStrings = activeTuning.strings.slice(3);

  return (
    <main className="app-shell">
      <section className="tuner-card" aria-label="吉他调音器">
        <header className="topbar">
          <div>
            <p className="eyebrow">GUITAR TUNER</p>
            <h1>调音</h1>
          </div>
          <div className="listen-control">
            <span className={`live-dot ${status === "listening" ? "is-live" : ""}`} aria-hidden="true" />
            <span>{describeStatus(status, reading)}</span>
            <button className="mic-button" onClick={status === "listening" ? stopListening : startListening}>
              {status === "listening" ? "停止" : "启动麦克风"}
            </button>
          </div>
        </header>

        <div className="setting-row">
          <button className="tuning-selector" onClick={() => setShowTuningPanel(true)} aria-haspopup="dialog">
            <span>吉他 6 弦</span>
            <small>{activeTuning.name}</small>
          </button>
          <label className="switch-label">
            <span>自动</span>
            <input
              type="checkbox"
              checked={automatic}
              onChange={(event) => {
                const isAutomatic = event.target.checked;
                setAutomatic(isAutomatic);
                automaticRef.current = isAutomatic;
              }}
            />
          </label>
        </div>

        <section className="pitch-zone" aria-live="polite">
          <div className="accidental accidental-flat">♭</div>
          <div className="accidental accidental-sharp">♯</div>
          <div className="center-line" aria-hidden="true" />
          <div className={`pitch-readout ${inTune ? "is-in-tune" : ""}`}>
            <div className="needle-anchor">
              <span className="needle" style={{ transform: `translateX(-50%) rotate(${needleRotation}deg)` }} aria-hidden="true" />
            </div>
            <div className="cents-value">{reading ? `${cents > 0 ? "+" : ""}${Math.round(cents)}` : "—"}</div>
            <div className="cents-label">cents</div>
          </div>
          <div className={`direction-pill ${inTune ? "is-in-tune" : ""}`}>{direction || "弹响一根琴弦"}</div>
        </section>

        <section className="instrument-zone">
          <div className="strings-column strings-left" aria-label="低音弦">
            {leftStrings.map((target) => (
              <button
                className={`string-button ${target.id === selectedTarget.id ? "is-selected" : ""}`}
                key={target.id}
                onClick={() => chooseString(target.id)}
                aria-pressed={target.id === selectedTarget.id}
              >
                <span>{target.note}</span><small>{target.octave}</small>
              </button>
            ))}
          </div>
          <div className="headstock-wrap">
            <img src={`${import.meta.env.BASE_URL}assets/guitar-headstock.png`} alt="木质六弦吉他琴头" />
          </div>
          <div className="strings-column strings-right" aria-label="高音弦">
            {rightStrings.map((target) => (
              <button
                className={`string-button ${target.id === selectedTarget.id ? "is-selected" : ""}`}
                key={target.id}
                onClick={() => chooseString(target.id)}
                aria-pressed={target.id === selectedTarget.id}
              >
                <span>{target.note}</span><small>{target.octave}</small>
              </button>
            ))}
          </div>
        </section>

        <footer className="tuner-footer">
          <div>
            <strong>{noteLabel(selectedTarget)}</strong>
            <span>{reading ? `${reading.frequency.toFixed(1)} Hz · 信号 ${Math.round(reading.clarity * 100)}%` : "A4 = 440 Hz · 本地音频处理"}</span>
          </div>
          <button className="text-button" onClick={() => setShowTuningPanel(true)}>调弦设置</button>
        </footer>
      </section>

      {showTuningPanel && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowTuningPanel(false)}>
          <section className="tuning-panel" role="dialog" aria-modal="true" aria-labelledby="tuning-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading">
              <div><p className="eyebrow">TUNING LIBRARY</p><h2 id="tuning-title">选择调弦</h2></div>
              <button className="close-button" onClick={() => setShowTuningPanel(false)}>关闭</button>
            </div>
            <div className="tuning-list">
              {BUILT_IN_TUNINGS.map((tuning) => (
                <button className={`tuning-option ${activeTuning.id === tuning.id ? "is-active" : ""}`} key={tuning.id} onClick={() => chooseTuning(tuning.id)}>
                  <span>{tuning.name}</span>
                  <small>{tuning.strings.map(noteLabel).join(" · ")}</small>
                </button>
              ))}
            </div>
            {customTunings.length > 0 && <>
              <p className="section-label">我的调弦</p>
              <div className="tuning-list">
                {customTunings.map((tuning) => (
                  <div className="custom-option" key={tuning.id}>
                    <button className={`tuning-option ${activeTuning.id === tuning.id ? "is-active" : ""}`} onClick={() => chooseTuning(tuning.id)}>
                      <span>{tuning.name}</span><small>{tuning.strings.map(noteLabel).join(" · ")}</small>
                    </button>
                    <div className="custom-actions">
                      <button className="edit-button" onClick={() => editDraft(tuning)}>编辑</button>
                      <button className="edit-button" onClick={() => exportCustomTuning(tuning)}>导出</button>
                      <button className="delete-button" onClick={() => removeCustomTuning(tuning.id)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </>}
            <div className="library-actions">
              <button className="secondary-button" onClick={openImporter}>从 GitHub 导入</button>
              <button className="new-tuning-button" onClick={startNewDraft}>创建自定义调弦</button>
            </div>
          </section>
        </div>
      )}

      {showEditor && (
        <div className="modal-backdrop editor-layer" role="presentation" onMouseDown={() => setShowEditor(false)}>
          <section className="tuning-panel editor-panel" role="dialog" aria-modal="true" aria-labelledby="editor-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading"><div><p className="eyebrow">CUSTOM TUNING</p><h2 id="editor-title">自定义调弦</h2></div><button className="close-button" onClick={() => setShowEditor(false)}>取消</button></div>
            <label className="name-field">名称<input value={draftName} maxLength={24} onChange={(event) => setDraftName(event.target.value)} /></label>
            <div className="string-editor">
              {draftStrings.map((item, index) => (
                <div className="string-editor-row" key={index}>
                  <span>第 {6 - index} 弦</span>
                  <select value={item.note} onChange={(event) => setDraftStrings((current) => current.map((entry, row) => row === index ? { ...entry, note: event.target.value } : entry))}>
                    {NOTE_OPTIONS.map((note) => <option value={note} key={note}>{note}</option>)}
                  </select>
                  <select value={item.octave} onChange={(event) => setDraftStrings((current) => current.map((entry, row) => row === index ? { ...entry, octave: Number(event.target.value) } : entry))}>
                    {[1, 2, 3, 4, 5].map((octave) => <option value={octave} key={octave}>{octave}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <button className="new-tuning-button" onClick={saveDraft}>{editingTuningId ? "保存修改" : "保存到本机"}</button>
          </section>
        </div>
      )}

      {showImporter && (
        <div className="modal-backdrop editor-layer" role="presentation" onMouseDown={() => setShowImporter(false)}>
          <section className="tuning-panel import-panel" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading"><div><p className="eyebrow">GITHUB IMPORT</p><h2 id="import-title">导入调弦配置</h2></div><button className="close-button" onClick={() => setShowImporter(false)}>关闭</button></div>
            <p className="import-copy">粘贴 GitHub 文件页、Raw 链接或单文件 Gist 的 JSON 链接。读取只发生在当前浏览器，导入后仅保存到本机。</p>
            <label className="name-field">GitHub 配置链接<textarea value={importUrl} rows={4} placeholder="https://github.com/owner/repo/blob/main/tuning.json" onChange={(event) => setImportUrl(event.target.value)} /></label>
            <p className="import-example">支持单个配置，或 <code>{'{ "tunings": [...] }'}</code> 格式。可先导出本机方案，再将 JSON 上传到 GitHub 共享。</p>
            {importMessage && <p className={`import-message ${importMessage.startsWith("已导入") ? "is-success" : ""}`}>{importMessage}</p>}
            <button className="new-tuning-button" disabled={isImporting || !importUrl.trim()} onClick={importFromGitHub}>{isImporting ? "正在导入…" : "导入到本机"}</button>
          </section>
        </div>
      )}
    </main>
  );
}
