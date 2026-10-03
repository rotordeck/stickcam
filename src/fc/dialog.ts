// "Flight controller logging" dialog: read the blackbox settings off the whoop, pick what to log
// (presets or per-field), apply them, restore the previous ones, or erase the flash after a download.

import {
  API_1_44, API_1_45, DEVICES, DEVICE_FLASH, PROFILES, applyProfile, cliCommands, describeChanges, estimate, fieldTable, isFieldOn,
  rateLabel, type BbConfig,
} from './blackbox.ts';
import { FcError, FcLink, apiMinor, boardInfo, eraseFlash, flashSummary, getBlackboxConfig, setBlackboxConfig, type FlashSummary } from './fc.ts';

const PREV_KEY = 'stickcam.fc.previous';

function loadPrev(): BbConfig | null {
  try { return JSON.parse(localStorage.getItem(PREV_KEY) ?? 'null'); } catch { return null; }
}
function savePrev(c: BbConfig) {
  try { localStorage.setItem(PREV_KEY, JSON.stringify(c)); } catch { /* storage can be blocked */ }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export interface DialogHooks {
  /** Size in bytes of the log downloaded from the FC this session (0 if none). Erase is only offered after one. */
  downloadedBytes(): number;
  onErased(): void;
}

/** Wire the dialog to its trigger button. */
export function initFcDialog(dlg: HTMLDialogElement, trigger: HTMLButtonElement, hooks: DialogHooks) {
  trigger.onclick = () => void open();

  async function open() {
    dlg.replaceChildren();
    const body = el('div', 'fcs');
    dlg.append(body);
    const msg = el('p', 'muted', 'Choose your flight controller…');
    body.append(el('h3', '', 'Flight controller logging'), msg);
    dlg.showModal();

    let link: FcLink | null = null;
    const close = () => { void link?.close(); link = null; };
    dlg.addEventListener('close', close, { once: true });

    try {
      link = await FcLink.connect();
      msg.textContent = 'Reading settings…';
      const minor = await apiMinor(link);
      const info = await boardInfo(link);
      const cfg = await getBlackboxConfig(link, minor);
      const flash = await flashSummary(link);
      msg.remove();
      render(body, link, minor, info.name, info.pidHz, cfg, flash);
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.classList.add('err');
      body.append(closeButton());
    }
  }

  const closeButton = () => { const b = el('button', '', 'Close'); b.onclick = () => dlg.close(); return b; };

  function render(body: HTMLElement, link: FcLink, minor: number, board: string, pidHzRaw: number, current: BbConfig, flash: FlashSummary) {
    body.replaceChildren();
    const table = fieldTable(minor);
    const pidHz = pidHzRaw || 4000;
    let saved = current; // what is on the FC right now
    let work: BbConfig = { ...current };
    let confirmErase = false;

    const info = el('p', 'muted');
    const profiles = el('div', 'seg');
    const fields = el('div', 'fcfields');
    const rateRow = el('label', 'row');
    const rateSel = el('select');
    const est = el('p', 'fcest');
    const warn = el('p', 'fcwarn');
    const changes = el('ul', 'fcchanges');
    const status = el('p', 'status');
    const actions = el('div', 'dlg-actions');
    const apply = el('button', 'go', 'Apply to flight controller');
    const restore = el('button', '', 'Restore previous');
    const cli = el('button', '', 'Copy CLI commands');
    const erase = el('button', 'danger', 'Erase flash…');
    actions.append(apply, restore, cli, erase, closeButton());

    const canEdit = current.supported && current.device === DEVICE_FLASH && minor >= API_1_44;
    const canMask = canEdit && current.mask !== null && minor >= API_1_45;

    function describeFc() {
      const dev = DEVICES[work.device] ?? `device ${work.device}`;
      info.textContent = `${board || 'Flight controller'} · Betaflight API 1.${minor} · logging to ${dev}` +
        (flash.supported ? ` · flash ${(flash.used / 1048576).toFixed(1)} of ${(flash.total / 1048576).toFixed(0)} MB used` : '');
    }

    function refresh() {
      describeFc();
      profiles.querySelectorAll('button').forEach((b, i) => {
        const p = PROFILES[i];
        const want = applyProfile(work, p, table);
        b.classList.toggle('on', want.sampleRate === work.sampleRate && want.mask === work.mask);
      });
      fields.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
        const f = table.find((x) => x.id === i.dataset.id)!;
        i.checked = isFieldOn(work.mask, f);
      });
      rateSel.value = String(work.sampleRate);
      for (const o of [...rateSel.options]) o.textContent = rateLabel(pidHzRaw, Number(o.value));
      const e = estimate(work, minor, pidHz, flash.total || 16 * 1048576);
      est.textContent = `≈ ${e.bytesPerSec >= 1000 ? (e.bytesPerSec / 1000).toFixed(1) + ' kB' : Math.round(e.bytesPerSec) + ' B'}/s → about ${Math.round(e.minutes)} min of logging in ${((flash.total || 16 * 1048576) / 1048576).toFixed(0)} MB` +
        (pidHzRaw ? '' : ' (assuming a 4 kHz PID loop)') + '. A rough estimate.';
      const missing = canMask ? table.filter((f) => f.need && !isFieldOn(work.mask, f)) : [];
      warn.textContent = missing.map((f) => `${f.label} is off: ${f.need}`).join(' ');
      const diff = describeChanges(saved, work, minor, pidHzRaw);
      changes.replaceChildren(...diff.map((d) => el('li', '', d)));
      apply.disabled = !canEdit || diff.length === 0;
      apply.textContent = diff.length ? `Apply ${diff.length} change${diff.length > 1 ? 's' : ''}` : 'No changes';
      const prev = loadPrev();
      restore.disabled = !canEdit || !prev;
      erase.disabled = flash.used === 0 || hooks.downloadedBytes() < flash.used;
      erase.title = erase.disabled ? 'Download the log first (Read from flight controller), then you can erase it here.' : '';
      erase.textContent = confirmErase ? 'Really erase? Click again' : 'Erase flash…';
    }

    if (!canEdit) {
      const why = !current.supported ? 'This flight controller has no blackbox support.'
        : current.device !== DEVICE_FLASH ? `Blackbox logs to ${DEVICES[current.device] ?? 'another device'}, not the onboard flash. StickCam can only change settings for flash logging; switch the device in Betaflight Configurator first (SD-card logs can only be read by taking the card out).`
        : `This firmware (API 1.${minor}) is too old to change logging settings from here. Use Betaflight 4.3 or newer.`;
      body.append(el('h3', '', 'Flight controller logging'), info, el('p', 'fcwarn', why));
    } else {
      body.append(el('h3', '', 'Flight controller logging'), info);
      body.append(el('p', 'muted', 'StickCam only needs your sticks and the gyro. Everything else uses up the flash. Pick a profile or switch fields yourself.'));
      PROFILES.forEach((p) => {
        const b = el('button', '', p.title);
        b.title = p.blurb;
        b.onclick = () => { work = applyProfile(work, p, table); refresh(); };
        profiles.append(b);
      });
      body.append(profiles);
      if (canMask) {
        for (const f of table) {
          const row = el('label', 'fcfield');
          const cb = el('input'); cb.type = 'checkbox'; cb.dataset.id = f.id;
          cb.onchange = () => { work = { ...work, mask: ((work.mask ?? 0) & ~(1 << f.bit)) | (cb.checked ? 0 : 1 << f.bit) }; refresh(); };
          row.append(cb, el('span', '', f.label));
          if (f.need) row.append(el('small', '', 'needed'));
          fields.append(row);
        }
        body.append(fields);
      }
      rateRow.append(el('span', '', 'Log rate'), rateSel);
      for (let n = 0; n <= 4; n++) rateSel.append(new Option('', String(n)));
      rateSel.onchange = () => { work = { ...work, sampleRate: Number(rateSel.value) }; refresh(); };
      body.append(rateRow, est, warn, changes);
    }
    body.append(status, actions);

    apply.onclick = async () => {
      const diff = describeChanges(saved, work, minor, pidHzRaw);
      apply.disabled = true;
      status.classList.remove('err');
      status.textContent = 'Writing to the flight controller…';
      try {
        const before = saved;
        saved = await setBlackboxConfig(link, work, minor);
        savePrev(before);
        work = { ...saved };
        status.textContent = `Saved to the flight controller (${diff.length} change${diff.length > 1 ? 's' : ''}). New logs use these settings.`;
      } catch (e) {
        status.textContent = (e as Error).message;
        status.classList.add('err');
      }
      refresh();
    };
    restore.onclick = () => {
      const prev = loadPrev();
      if (prev) { work = { ...work, sampleRate: prev.sampleRate, mask: prev.mask }; refresh(); status.textContent = 'Previous settings loaded. Press Apply to write them.'; }
    };
    cli.onclick = async () => {
      try { await navigator.clipboard.writeText(cliCommands(work, minor)); status.textContent = 'Copied. Paste into the CLI tab of Betaflight Configurator.'; }
      catch { status.textContent = cliCommands(work, minor); }
    };
    erase.onclick = async () => {
      if (!confirmErase) { confirmErase = true; refresh(); return; }
      confirmErase = false;
      erase.disabled = true;
      status.classList.remove('err');
      status.textContent = 'Erasing the flash… this takes a few seconds.';
      try {
        await eraseFlash(link);
        flash = await flashSummary(link);
        hooks.onErased();
        status.textContent = 'Flash erased. You have the full capacity again.';
      } catch (e) {
        status.textContent = e instanceof FcError ? e.message : String(e);
        status.classList.add('err');
      }
      refresh();
    };
    refresh();
  }
}
