// hud.js — the DOM layer: crosshair, health, ammo, money, timer, score,
// alive pips, kill feed, buy menu, banners and the menu overlay.
//
// The sim owns the numbers; this module only renders them, and only
// writes a node when its text actually changed, so calling refresh()
// from every fixed sim step stays cheap even at 2 rendered fps. The
// debug harness reads #overlay, #buy, .buy-item and #spectate, so
// those ids and classes are part of the game's contract.

import { ARMOR_MAX, ARMOR_PRICE, GRENADE_PRICE, WEAPONS } from './config.js';

const BUY_ITEMS = [
  { id: 'smg', label: 'VK-9 Ripper', sub: 'SMG · auto · 30 rnd', price: WEAPONS.smg.price },
  { id: 'rifle', label: 'AR-77 Longline', sub: 'Rifle · auto · 30 rnd', price: WEAPONS.rifle.price },
  { id: 'sniper', label: 'LR-50 Deadeye', sub: 'Sniper · bolt · 5 rnd', price: WEAPONS.sniper.price },
  { id: 'armor', label: 'Plated Vest', sub: 'Armour · 50 pts', price: ARMOR_PRICE },
  { id: 'grenade', label: 'Frag Grenade', sub: 'Throw with G', price: GRENADE_PRICE },
];

export class Hud {
  constructor(game) {
    this.game = game;
    this.cache = new Map();
    this.el = {};
    for (const id of [
      'overlay', 'overlay-title', 'overlay-sub', 'play', 'hud', 'cross', 'hitmarker',
      'health-fill', 'health-num', 'armor-fill', 'armor-num', 'ammo', 'money',
      'timer', 'score', 'pips', 'killfeed', 'banner', 'banner-sub', 'buy',
      'buy-money', 'spectate', 'spectate-name', 'objective', 'progress',
      'progress-fill', 'progress-label', 'vignette', 'hint',
    ]) {
      this.el[id] = document.getElementById(id);
    }
    // Build the buy menu from the price table — one source of truth.
    const list = document.getElementById('buy-list');
    for (const item of BUY_ITEMS) {
      const btn = document.createElement('button');
      btn.className = 'buy-item';
      btn.dataset.item = item.id;
      btn.innerHTML = `<span class="buy-name">${item.label}</span><span class="buy-sub">${item.sub}</span><span class="buy-price">$${item.price}</span>`;
      btn.addEventListener('click', () => this.game.buy(item.id));
      list.appendChild(btn);
    }
    this.el.play.addEventListener('click', () => this.game.uiStart());
    this.el.buy.addEventListener('click', (e) => {
      if (e.target === this.el.buy) this.hideBuy();
    });
  }

  /** Write text only when it changed. */
  set(id, text) {
    if (this.cache.get(id) !== text) {
      this.cache.set(id, text);
      const node = this.el[id];
      if (node) node.textContent = text;
    }
  }

  show(node) {
    if (node.hidden) node.hidden = false;
  }

  hide(node) {
    if (!node.hidden) node.hidden = true;
  }

  showBuy() {
    this.show(this.el.buy);
    this.set('buy-money', `$${this.game.money()}`);
    // The round banner and the buy menu share the centre of the screen;
    // the menu wins while it is open. The next banner() call re-shows it.
    clearTimeout(this.bannerTimer);
    this.el.banner.parentElement.classList.remove('show');
  }

  hideBuy() {
    this.hide(this.el.buy);
  }

  get buyOpen() {
    return !this.el.buy.hidden;
  }

  /** Full HUD refresh from the sim state. Cheap: cached writes. */
  refresh() {
    const g = this.game;
    const S = g.state;
    const p = g.player;
    const t = Math.max(0, Math.ceil(S.timer));
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    const timerText = S.charge.status === 'planted' ? `◉ ${mm}:${ss}` : `${mm}:${ss}`;
    this.set('timer', timerText);
    this.el.timer.classList.toggle('planted', S.charge.status === 'planted');
    this.set('score', `${S.score.ember} — ${S.score.slate}`);
    this.set('money', `$${g.money()}`);
    this.set('ammo', p.weapon === 'pistol' && p.ammo === 0 && p.reserve === 0
      ? '—'
      : `${p.ammo} / ${p.reserve}`);
    this.set('health-num', String(Math.max(0, Math.ceil(p.health))));
    this.set('armor-num', String(Math.max(0, Math.ceil(p.armor))));
    this.el['health-fill'].style.width = `${Math.max(0, p.health)}%`;
    this.el['armor-fill'].style.width = `${Math.max(0, (p.armor / ARMOR_MAX) * 100)}%`;
    this.el['health-fill'].classList.toggle('low', p.health <= 30);

    // Alive pips: one dot per actor, Ember amber, Slate blue, dead dim.
    let pips = '';
    for (const a of g.actors) {
      pips += `<span class="pip ${a.team} ${a.alive ? '' : 'dead'}" title="${a.name}"></span>`;
    }
    if (this.cache.get('pips') !== pips) {
      this.cache.set('pips', pips);
      this.el.pips.innerHTML = pips;
    }

    // Objective line.
    let objective = '';
    if (S.phase === 'buy') objective = 'Buy phase — press B to shop';
    else if (S.charge.status === 'planted') objective = S.carrier === null ? 'Charge planted — defend it' : 'Charge planted';
    else if (S.carrier === p) objective = 'You carry the charge — plant at A or B';
    else if (S.carrier) objective = `${S.carrier.name} carries the charge — cover them`;
    else objective = 'Charge dropped — pick it up';
    this.set('objective', objective);

    // Spectate overlay while the player is dead and the round runs on.
    if (!p.alive && (S.phase === 'live' || S.phase === 'roundEnd')) {
      this.show(this.el.spectate);
      const mate = g.actors.find((a) => a.team === 'ember' && a.alive && !a.isPlayer);
      this.set('spectate-name', mate ? `Spectating ${mate.name}` : 'Your team is down');
    } else {
      this.hide(this.el.spectate);
    }

    // Plant / defuse progress bar.
    const prog = g.channelProgress();
    if (prog) {
      this.show(this.el.progress);
      this.set('progress-label', prog.label);
      this.el['progress-fill'].style.width = `${Math.round(prog.frac * 100)}%`;
    } else {
      this.hide(this.el.progress);
    }

    // Damage vignette fades with health.
    this.el.vignette.style.opacity = p.alive ? String(Math.max(0, (55 - p.health) / 55) * 0.85) : '0.4';
    this.el.hud.classList.toggle('dead', !p.alive);
  }

  /** Crosshair spread follows the live cone, in pixels. */
  setSpread(px) {
    this.el.cross.style.setProperty('--gap', `${px.toFixed(1)}px`);
  }

  hitmarker(headshot, killed) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'head', 'kill');
    // Force a reflow so the animation restarts on every hit.
    void h.offsetWidth;
    h.classList.add('show');
    if (headshot) h.classList.add('head');
    if (killed) h.classList.add('kill');
  }

  killfeed(html) {
    const feed = this.el.killfeed;
    const line = document.createElement('div');
    line.className = 'feed-line';
    line.innerHTML = html;
    feed.prepend(line);
    while (feed.children.length > 5) feed.removeChild(feed.lastChild);
    setTimeout(() => line.classList.add('fade'), 4200);
  }

  banner(title, sub, tone) {
    this.set('banner', title);
    this.set('banner-sub', sub);
    const b = this.el.banner;
    b.parentElement.className = `banner-wrap show ${tone || ''}`;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      b.parentElement.classList.remove('show');
    }, 3600);
  }

  /** Clear the round banner at once (the screenshot staging uses this
   *  so a frame shows the fight, not the announcement). */
  hideBanner() {
    clearTimeout(this.bannerTimer);
    this.el.banner.parentElement.classList.remove('show');
  }

  showMenu(title, sub) {
    this.set('overlay-title', title);
    this.set('overlay-sub', sub);
    this.show(this.el.overlay);
    this.hide(this.el.hud);
  }

  hideMenu() {
    this.hide(this.el.overlay);
    this.show(this.el.hud);
  }

  flashHint(text) {
    this.set('hint', text);
    this.el.hint.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.el.hint.classList.remove('show'), 2600);
  }
}
