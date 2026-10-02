// Dn-FamiTracker web port - the editor's Help menu: how to use it with the keys as they are
// set now (Help Topics), the table of the effects the module's chips take (Effect Table),
// and what the editor is made of (About). The texts are in dnft-editor-strings.mjs.
//
//   const help = new Help(editor);
//   help.openTopics(); help.openEffects(); help.openAbout();

import { COMMANDS, GROUPS, formatCombo } from './dnft-keymap.mjs';

// The chips of the module (SNDCHIP_*) and how the effect table names them
const CHIP_NAMES = [[0, '2A03'], [1, 'VRC6'], [2, 'VRC7'], [4, 'FDS'], [8, 'MMC5'], [16, 'N163'], [32, '5B']];

// What follows an effect's letter (effect_t, the parameter as xx, or x and y)
const PARAMETERS = {
  1: 'xx', 2: 'xx', 3: 'xx', 4: 'xx', 5: 'xx', 6: 'xx', 8: 'xy', 9: 'xy', 10: 'xy', 11: 'xy', 12: 'xy', 13: 'xx',
  14: 'xx', 15: 'xx', 16: 'xx', 17: 'xx', 18: 'xx', 19: 'xx', 20: 'xy', 21: 'xy', 22: 'xy', 23: 'xx', 24: 'xx',
  25: 'xy', 26: 'xx', 27: 'xx', 28: 'xx', 29: 'xx', 30: 'xy', 31: 'xx', 32: 'xx', 33: 'xx', 34: 'xx', 35: 'xx',
  36: 'xx', 37: 'xx', 38: 'xy', 39: 'xx', 40: 'xx', 41: 'xx', 42: 'xx', 43: 'xx', 44: 'xy',
};

const escape = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Help {
  constructor(editor) {
    this.editor = editor;
    this.dialogs = {};
  }

  get strings() {
    return this.editor.strings;
  }

  // A dialog of the editor's look that stays in the page, filled when it opens
  dialog(name, className, title, buttons = '') {
    if (!this.dialogs[name]) {
      const d = this.editor.files.dialog(`dnft-help-dialog ${className}`, '', `${buttons}<button type="button" class="dnft-button" data-role="close" data-t="close"></button>`);
      d.classList.remove('dnft-dialog--narrow');
      d.classList.add('dnft-dialog--wide');
      d.querySelector('[data-role="close"]').addEventListener('click', () => d.close());
      this.dialogs[name] = d;
    }
    const d = this.dialogs[name];
    d.querySelector('.dnft-dialog-title').textContent = title;
    return d;
  }

  show(d, html) {
    d.querySelector('.dnft-dialog-body').innerHTML = html;
    if (!d.open)
      d.showModal();
    d.querySelector('.dnft-dialog-body').scrollTop = 0;
  }

  // ---- Help Topics -------------------------------------------------------------------------

  openTopics() {
    const t = this.strings;
    const keymap = this.editor.keymap;
    const paragraphs = list => list.map(text => `<p>${escape(text)}</p>`).join('');
    const groups = GROUPS.map(group => {
      const rows = COMMANDS.filter(command => command.group === group && !command.hidden).map(command => {
        const keys = keymap.keysOf(command.id).map(formatCombo);
        return `<tr><td>${escape(t.commandNames[command.id] ?? command.id)}</td><td>${keys.length ? keys.map(key => `<kbd>${escape(key)}</kbd>`).join(' ') : '—'}</td></tr>`;
      }).join('');
      return `<h4>${escape(t.commandGroups[group])}</h4><table class="dnft-help-table"><tbody>${rows}</tbody></table>`;
    }).join('');
    this.show(this.dialog('topics', 'dnft-help-topics', t.helpTopicsTitle), `
      <section>
        <h3>${escape(t.helpBasics)}</h3>${paragraphs(t.helpBasicsText)}
        <h3>${escape(t.helpMouse)}</h3>${paragraphs(t.helpMouseText)}
        <h3>${escape(t.helpKeys)}</h3><p>${escape(t.helpKeysText)}</p>${groups}
      </section>`);
  }

  // ---- Effect Table --------------------------------------------------------------------------

  // The effects by the letters they are typed with (the tracker lists 0-9 then A-Z), what
  // each takes, and the chips whose channels take it
  openEffects() {
    const t = this.strings;
    const { letters, byChip } = this.editor.song.effects;
    const chipsOf = id => CHIP_NAMES.filter(([chip]) => Object.values(byChip[chip] ?? {}).includes(id)).map(([, name]) => name);
    const rows = letters
      .map((letter, id) => ({ letter, id }))
      .filter(({ letter, id }) => letter && t.effectInfo[id])
      .sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : a.id - b.id))
      .map(({ letter, id }) => {
        const [name, description] = t.effectInfo[id];
        const chips = chipsOf(id);
        const where = chips.length === CHIP_NAMES.length ? t.allChips : chips.join(', ');
        return `<tr><td><code>${escape(letter)}${PARAMETERS[id] ?? 'xx'}</code></td><td>${escape(name)}</td><td>${escape(description)}</td><td>${escape(where)}</td></tr>`;
      }).join('');
    this.show(this.dialog('effects', 'dnft-help-effects', t.effectTableTitle), `
      <p>${escape(t.effectTableIntro)}</p>
      <table class="dnft-help-table dnft-effect-table">
        <thead><tr><th>${escape(t.effectColumn)}</th><th>${escape(t.effectName)}</th><th>${escape(t.effectDescription)}</th><th>${escape(t.effectChips)}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  // ---- About ----------------------------------------------------------------------------------

  openAbout() {
    const t = this.strings;
    const source = this.editor.source;
    const link = (href, text) => `<a href="${escape(href)}" target="_blank" rel="noopener">${escape(text)}</a>`;
    this.show(this.dialog('about', 'dnft-help-about', t.aboutTitle), `
      <p>${escape(t.aboutText)}</p>
      <ul>
        <li>Dn-FamiTracker © 2020–2025 D.P.C.M.</li>
        <li>FamiTracker © 2005–2020 Jonathan Liss</li>
        <li>0CC-FamiTracker © 2014–2018 HertzDevil</li>
      </ul>
      <p>${escape(t.aboutLicense)}</p>
      <p>${source ? link(source, t.aboutSource) : ''} ${link('https://github.com/Dn-Programming-Core-Management/Dn-FamiTracker', 'Dn-FamiTracker')}</p>`);
  }
}
