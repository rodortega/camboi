import type { ClipMeta, EffectId, PipelineStatus, Settings } from '../shared/types';

export interface OverlayHandlers {
  onCommand(command: 'toggle-loop' | 'go-live' | 'step-away' | 'panic-freeze'): void;
  onEffect(effect: EffectId): void;
  onRecord(): void;
  onSelectClip(id: string): void;
  onOpenStudio(): void;
  onHide(): void;
}

const STATE_LABEL: Record<PipelineStatus['state'], string> = {
  live: 'Live',
  loop: 'Looping',
  'transition-to-loop': 'Stepping away…',
  'transition-to-live': 'Going live…',
  frozen: 'Frozen',
};

const CSS = `
:host { all: initial; }
.card {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  width: 264px; padding: 12px; box-sizing: border-box;
  font: 500 12px/1.4 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  color: #e9e9ee; background: rgba(20,20,26,.92);
  border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); backdrop-filter: blur(14px);
  user-select: none;
}
.card[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 8px; cursor: grab; margin-bottom: 10px; }
.head:active { cursor: grabbing; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #39d98a; flex: none; }
.dot.loop { background: #ffb020; }
.dot.frozen { background: #ff5d5d; }
.dot.off { background: #6b6b76; }
.title { font-weight: 650; letter-spacing: .2px; }
.sub { margin-left: auto; font-weight: 500; opacity: .55; font-variant-numeric: tabular-nums; }
.x { margin-left: 4px; cursor: pointer; opacity: .45; font-size: 14px; line-height: 1; }
.x:hover { opacity: .9; }
button, select {
  font: inherit; color: inherit; border-radius: 9px; box-sizing: border-box;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.07);
  padding: 7px 9px; cursor: pointer; width: 100%;
}
button:hover, select:hover { background: rgba(255,255,255,.13); }
button:disabled { opacity: .4; cursor: default; }
button.primary { background: #3f7dfb; border-color: #3f7dfb; font-weight: 650; }
button.primary:hover { background: #5a8ffc; }
button.danger { background: rgba(255,93,93,.18); border-color: rgba(255,93,93,.4); }
.row { display: flex; gap: 6px; margin-top: 6px; }
.row > * { flex: 1; }
label { display: block; margin: 10px 0 4px; font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .6px; opacity: .5; font-weight: 600; }
.warn { margin-top: 8px; padding: 6px 8px; border-radius: 8px; font-size: 11px;
  background: rgba(255,176,32,.14); color: #ffd48a; }
.toasts { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; }
.toast { padding: 8px 12px; border-radius: 10px; font: 500 12px ui-sans-serif, system-ui, sans-serif;
  color: #fff; background: rgba(20,20,26,.94); border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 8px 26px rgba(0,0,0,.4); animation: pop .18s ease-out; }
.toast.warn { background: rgba(120,70,10,.94); border-color: rgba(255,176,32,.4); }
@keyframes pop { from { opacity: 0; transform: translateY(6px); } }
`;

/**
 * In-page controls. Lives in a shadow root so no site stylesheet can reach it,
 * and so our markup cannot collide with the page's.
 */
export class Overlay {
  private readonly handlers: OverlayHandlers;
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private card!: HTMLDivElement;
  private toasts!: HTMLDivElement;
  private dot!: HTMLSpanElement;
  private stateText!: HTMLSpanElement;
  private resText!: HTMLSpanElement;
  private mainBtn!: HTMLButtonElement;
  private freezeBtn!: HTMLButtonElement;
  private recordBtn!: HTMLButtonElement;
  private clipSel!: HTMLSelectElement;
  private effectSel!: HTMLSelectElement;
  private warnBox!: HTMLDivElement;

  private status: PipelineStatus | null = null;
  private offset = { x: 0, y: 0 };

  constructor(handlers: OverlayHandlers) {
    this.handlers = handlers;
  }

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.id = 'camboi-overlay-root';
    host.style.cssText = 'all:initial;position:static';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="card" hidden>
        <div class="head" part="head">
          <span class="dot off"></span>
          <span class="title">CamBoi</span>
          <span class="sub"></span>
          <span class="x" title="Hide">&times;</span>
        </div>
        <button class="primary main">Step away</button>
        <div class="row">
          <button class="freeze">Freeze</button>
          <button class="record">Record 8s</button>
        </div>
        <label>Clip</label>
        <select class="clips"></select>
        <label>Effect</label>
        <select class="effects">
          <option value="none">None</option>
          <option value="stutter">Stutter</option>
          <option value="catchup">Catch-up lag</option>
          <option value="lowbitrate">Low bitrate</option>
        </select>
        <div class="warn" hidden></div>
      </div>
      <div class="toasts"></div>`;

    this.root = root;
    this.host = host;
    this.card = root.querySelector('.card')!;
    this.toasts = root.querySelector('.toasts')!;
    this.dot = root.querySelector('.dot')!;
    this.stateText = root.querySelector('.title')!;
    this.resText = root.querySelector('.sub')!;
    this.mainBtn = root.querySelector('.main')!;
    this.freezeBtn = root.querySelector('.freeze')!;
    this.recordBtn = root.querySelector('.record')!;
    this.clipSel = root.querySelector('.clips')!;
    this.effectSel = root.querySelector('.effects')!;
    this.warnBox = root.querySelector('.warn')!;

    this.mainBtn.addEventListener('click', () => this.handlers.onCommand('toggle-loop'));
    this.freezeBtn.addEventListener('click', () => this.handlers.onCommand('panic-freeze'));
    this.recordBtn.addEventListener('click', () => this.handlers.onRecord());
    this.clipSel.addEventListener('change', () => {
      if (this.clipSel.value === '__studio__') this.handlers.onOpenStudio();
      else this.handlers.onSelectClip(this.clipSel.value);
    });
    this.effectSel.addEventListener('change', () => this.handlers.onEffect(this.effectSel.value as EffectId));
    root.querySelector('.x')!.addEventListener('click', () => this.handlers.onHide());
    this.makeDraggable(root.querySelector('.head')!);

    (document.body ?? document.documentElement).appendChild(host);
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  setVisible(visible: boolean): void {
    if (this.card) this.card.hidden = !visible;
  }

  setStatus(status: PipelineStatus): void {
    this.status = status;
    if (!this.root) return;

    const looping = status.state === 'loop' || status.state === 'transition-to-loop';
    this.dot.className = `dot ${!status.attached ? 'off' : status.state === 'frozen' ? 'frozen' : looping ? 'loop' : ''}`;
    this.stateText.textContent = status.attached ? STATE_LABEL[status.state] : 'CamBoi — idle';
    this.resText.textContent = status.attached ? `${status.width}×${status.height}` : '';

    this.mainBtn.textContent = looping ? 'Go live' : 'Step away';
    this.mainBtn.disabled = !status.attached;
    this.freezeBtn.textContent = status.state === 'frozen' ? 'Unfreeze' : 'Freeze';
    this.freezeBtn.className = status.state === 'frozen' ? 'freeze danger' : 'freeze';
    this.freezeBtn.disabled = !status.attached;
    this.recordBtn.disabled = !status.attached;

    const problems: string[] = [];
    if (status.attached && !status.clipLoaded) problems.push('No clip selected.');
    if (status.attached && status.clockAgeMs > 700) problems.push('Frame clock is stalling.');
    this.warnBox.textContent = problems.join(' ');
    this.warnBox.hidden = problems.length === 0;
  }

  setClips(clips: ClipMeta[], activeId: string | null): void {
    if (!this.root) return;
    this.clipSel.innerHTML = '';
    if (!clips.length) {
      this.clipSel.append(new Option('No clips yet', '', true, true));
    }
    for (const clip of clips) {
      const seconds = (clip.frameCount / Math.max(1, clip.fps)).toFixed(1);
      this.clipSel.append(new Option(`${clip.pinned ? '★ ' : ''}${clip.name} · ${seconds}s`, clip.id, false, clip.id === activeId));
    }
    this.clipSel.append(new Option('Open Studio…', '__studio__'));
  }

  setSettings(settings: Settings): void {
    if (!this.root) return;
    this.effectSel.value = settings.effect;
    this.setVisible(settings.overlayVisible);
  }

  setRecording(active: boolean, label?: string): void {
    if (!this.root) return;
    this.recordBtn.textContent = active ? (label ?? 'Recording…') : 'Record 8s';
    this.recordBtn.disabled = active || !this.status?.attached;
    this.mainBtn.disabled = active || !this.status?.attached;
  }

  toast(text: string, tone: 'info' | 'warn' = 'info'): void {
    if (!this.root) return;
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  private makeDraggable(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (event) => {
      const rect = this.card.getBoundingClientRect();
      this.offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);

      const move = (e: PointerEvent) => {
        const x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, e.clientX - this.offset.x));
        const y = Math.max(4, Math.min(window.innerHeight - rect.height - 4, e.clientY - this.offset.y));
        this.card.style.left = `${x}px`;
        this.card.style.top = `${y}px`;
        this.card.style.right = 'auto';
        this.card.style.bottom = 'auto';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}
