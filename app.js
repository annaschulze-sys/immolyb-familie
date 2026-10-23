'use strict';

// ImmoLyb family view: loads the encrypted data published by the app from
// the Dropbox link after "#", decrypts it with the family password in the
// browser (nothing is sent anywhere) and shows it read only.
// All texts are inserted as text, never as HTML.

const app = document.getElementById('app');
const PASSWORD_KEY = 'immolyb-family-password';

const state = {
  data: null,
  key: null,
  tab: 'list',
  query: '',
  profile: '',
  progress: '',
  maxPrice: '',
  sort: 'newest',
  detail: null,
};

// ---------- helpers ----------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Only web addresses, never javascript: or similar. */
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

function price(value) {
  return typeof value === 'number' ? euro.format(value) : 'Preis auf Anfrage';
}

function date(value) {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleDateString('de-DE');
}

function stars(rating) {
  if (!rating) return '';
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function place(p) {
  return [p.street, [p.postalCode, p.city].filter(Boolean).join(' '), p.district]
    .filter(Boolean)
    .join(', ');
}

function bytes(base64) {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------- crypto (same format as the app) ----------

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function decrypt(key, data) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
}

// ---------- loading ----------

function dataLink() {
  const raw = decodeURIComponent(location.hash.slice(1));
  const url = safeUrl(raw);
  return url && new URL(url).hostname.endsWith('dropboxusercontent.com') ? url : null;
}

function loadSaved() {
  try { return localStorage.getItem(PASSWORD_KEY); } catch (_) { return null; }
}

function save(password) {
  try { localStorage.setItem(PASSWORD_KEY, password); } catch (_) { /* private mode */ }
}

function forget() {
  try { localStorage.removeItem(PASSWORD_KEY); } catch (_) { /* private mode */ }
}

async function start() {
  const link = dataLink();
  if (!link) {
    message('Dieser Link ist unvollständig. Bitte die vollständige Adresse aus ImmoLyb verwenden.');
    return;
  }
  let wrapper;
  try {
    const response = await fetch(link, { cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(response.status);
    wrapper = await response.json();
    if (wrapper.format !== 'immolyb-family') throw new Error('format');
  } catch (e) {
    message('Die Daten konnten nicht geladen werden. Bitte später erneut versuchen.');
    return;
  }
  const saved = loadSaved();
  if (saved && await unlock(wrapper, saved)) return;
  login(wrapper, saved ? 'Das gespeicherte Passwort passt nicht mehr.' : '');
}

async function unlock(wrapper, password) {
  try {
    const key = await deriveKey(password, bytes(wrapper.salt), wrapper.iterations);
    const plain = await decrypt(key, bytes(wrapper.data));
    state.data = JSON.parse(new TextDecoder().decode(plain));
    state.key = key;
    document.getElementById('stand').textContent = 'Stand: ' + date(state.data.createdAt);
    render();
    return true;
  } catch (_) {
    return false;
  }
}

function message(text) {
  app.replaceChildren(el('p', { class: 'muted' }, text));
}

function login(wrapper, error) {
  const input = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const remember = el('input', { type: 'checkbox' });
  const status = el('p', { class: 'error', role: 'alert' }, error);
  const button = el('button', { class: 'primary', type: 'submit' }, 'Öffnen');
  const form = el('form', {
    class: 'login',
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = '';
      button.textContent = 'Wird entschlüsselt …';
      if (await unlock(wrapper, input.value)) {
        if (remember.checked) save(input.value); else forget();
        return;
      }
      button.disabled = false;
      button.textContent = 'Öffnen';
      status.textContent = 'Das Passwort ist falsch.';
    },
  },
    el('h2', {}, 'Familien-Ansicht'),
    el('p', { class: 'muted' }, 'Bitte das Familien-Passwort eingeben. Die Daten werden nur hier im Browser entschlüsselt.'),
    el('label', {}, 'Passwort', input),
    el('label', { class: 'check' }, remember, 'Auf diesem Gerät merken'),
    button,
    status,
  );
  app.replaceChildren(form);
  input.focus();
}

// ---------- list ----------

function filtered() {
  const q = state.query.trim().toLowerCase();
  const max = Number(state.maxPrice);
  const list = state.data.properties.filter((p) => {
    if (q && ![p.title, p.city, p.district, p.street, p.postalCode, p.provider]
      .some((v) => v && String(v).toLowerCase().includes(q))) return false;
    if (state.profile === '-') { if (p.profiles.length) return false; }
    else if (state.profile && !p.profiles.some((a) => a.id === state.profile)) return false;
    if (state.progress === '-') { if (p.progress) return false; }
    else if (state.progress && p.progress !== state.progress) return false;
    else if (!state.progress && p.progress === 'Abgelehnt') return false;
    if (max > 0 && !(typeof p.price === 'number' && p.price <= max)) return false;
    return true;
  });
  const by = {
    newest: (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
    priceUp: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    priceDown: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    area: (a, b) => (b.livingArea ?? 0) - (a.livingArea ?? 0),
    rating: (a, b) => best(b) - best(a),
  }[state.sort];
  return list.sort(by);
}

function best(p) {
  return Math.max(0, ...p.profiles.map((a) => a.rating || 0));
}

function select(value, options, onchange, label) {
  return el('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
    options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
}

function render() {
  window.scrollTo(0, 0);
  if (state.detail) return renderDetail(state.detail);
  const tabs = el('div', { class: 'tabs' },
    el('button', { 'aria-pressed': String(state.tab === 'list'), onclick: () => { state.tab = 'list'; render(); } }, 'Immobilien'),
    el('button', { 'aria-pressed': String(state.tab === 'profiles'), onclick: () => { state.tab = 'profiles'; render(); } }, 'Suchprofile'),
  );
  app.replaceChildren(tabs, state.tab === 'profiles' ? renderProfiles() : renderList());
}

function renderList() {
  const data = state.data;
  const progresses = [...new Set(data.properties.map((p) => p.progress).filter(Boolean))];
  const search = el('input', {
    type: 'search', placeholder: 'Suchen (Titel, Ort, Straße …)', value: state.query,
    'aria-label': 'Suchen',
    oninput: (e) => { state.query = e.target.value; update(); },
  });
  const grid = el('div', { class: 'grid' });
  const count = el('span', { class: 'muted small' });
  function update() {
    const list = filtered();
    const rejected = data.properties.filter((p) => p.progress === 'Abgelehnt').length;
    count.textContent = `${list.length} von ${data.properties.length} Immobilien`
      + (!state.progress && rejected ? ` · ${rejected} abgelehnte ausgeblendet (Filter „Stand“)` : '');
    grid.replaceChildren(...list.map(card));
  }
  const filters = el('div', { class: 'filters' },
    search,
    select(state.profile, [['', 'Alle Suchprofile'], ...data.profiles.map((p) => [p.id, p.name]), ['-', 'Nicht zugeordnet']],
      (v) => { state.profile = v; update(); }, 'Suchprofil'),
    select(state.progress, [['', 'Jeder Stand'], ...progresses.map((p) => [p, p]), ['-', 'Ohne Stand']],
      (v) => { state.progress = v; update(); }, 'Stand'),
    el('input', {
      type: 'number', inputmode: 'numeric', min: '0', step: '10000', placeholder: 'Preis bis €',
      value: state.maxPrice, 'aria-label': 'Preis bis',
      oninput: (e) => { state.maxPrice = e.target.value; update(); },
    }),
    select(state.sort, [['newest', 'Neueste zuerst'], ['priceUp', 'Preis aufsteigend'],
      ['priceDown', 'Preis absteigend'], ['area', 'Größte Wohnfläche'], ['rating', 'Beste Bewertung']],
      (v) => { state.sort = v; update(); }, 'Sortierung'),
    count,
  );
  update();
  return el('div', {}, filters, grid);
}

function image(src, cls) {
  const url = safeUrl(src);
  return url
    ? el('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', class: cls })
    : el('div', { class: 'noimg' });
}

function card(p) {
  const facts = [
    p.livingArea && `${number.format(p.livingArea)} m²`,
    p.rooms && `${number.format(p.rooms)} Zi.`,
    p.plotArea && `${number.format(p.plotArea)} m² Grund`,
  ].filter(Boolean).join(' · ');
  return el('button', { class: 'card', onclick: () => { state.detail = p; history.pushState({ detail: p.id }, ''); render(); } },
    image(p.images[0]),
    el('div', { class: 'body' },
      el('h3', {}, p.title),
      el('div', { class: 'price' }, price(p.price)),
      facts && el('div', { class: 'small' }, facts),
      el('div', { class: 'muted small' }, place(p)),
      el('div', { class: 'chips' }, p.progress && el('span', { class: 'chip progress' }, p.progress)),
      p.profiles.map(profileLine),
    ),
  );
}

function profileLine(a) {
  return el('div', { class: 'profile-line' },
    el('b', {}, a.name), ' ',
    a.rating ? el('span', { class: 'stars', 'aria-label': `${a.rating} von 5 Sternen` }, stars(a.rating)) : '',
    ' ', a.status,
    a.deviations && a.deviations.length ? el('span', { class: 'deviation' }, ' · ' + a.deviations.join(', ')) : '',
  );
}

// ---------- profiles ----------

function renderProfiles() {
  const data = state.data;
  const count = (id) => data.properties.filter((p) => p.profiles.some((a) => a.id === id)).length;
  const none = data.properties.filter((p) => !p.profiles.length).length;
  const open = (id) => { state.profile = id; state.tab = 'list'; render(); };
  return el('div', { class: 'profiles' },
    data.profiles.map((p) => el('button', { onclick: () => open(p.id) },
      el('b', {}, p.name),
      p.criteria && el('span', { class: 'muted small' }, p.criteria),
      el('span', { class: 'small' }, `${count(p.id)} Immobilien`),
    )),
    el('button', { onclick: () => open('-') }, el('b', {}, 'Nicht zugeordnet'), el('span', { class: 'small' }, `${none} Immobilien`)),
  );
}

// ---------- detail ----------

function section(title, ...children) {
  const content = children.flat().filter(Boolean);
  if (!content.length) return null;
  return el('section', { class: 'section' }, el('h3', {}, title), content);
}

function renderDetail(p) {
  const facts = [
    ['Preis', price(p.price)],
    ['Wohnfläche', p.livingArea && `${number.format(p.livingArea)} m²`],
    ['Grundstück', p.plotArea && `${number.format(p.plotArea)} m²`],
    ['Zimmer', p.rooms && number.format(p.rooms)],
    ['Baujahr', p.yearBuilt],
    ['Angebotsart', p.offerType],
    ['Zustand', p.condition],
    ['Heizung', p.heating],
    ['Energieträger', p.energySource],
    ['Energieklasse', p.energyClass],
    ['Zielpreis', typeof p.targetPrice === 'number' && euro.format(p.targetPrice)],
    ['Sanierungskosten (geschätzt)', typeof p.renovationCost === 'number' && euro.format(p.renovationCost)],
    ['Anbieter', p.provider],
    ['Gespeichert am', date(p.addedAt)],
  ].filter(([, v]) => v);
  const maps = p.location
    ? `https://www.google.com/maps/search/?api=1&query=${p.location.lat},${p.location.lng}`
    : place(p) && `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place(p))}`;
  app.replaceChildren(el('div', { class: 'detail' },
    el('div', {}, el('button', { class: 'back', onclick: () => history.back() }, '← Zurück')),
    el('h2', {}, p.title),
    el('div', { class: 'chips' },
      p.progress && el('span', { class: 'chip progress' }, p.progress),
      p.tags.map((t) => el('span', { class: 'chip' }, t))),
    p.images.length ? el('div', { class: 'gallery' }, p.images.map((src) => image(src))) : null,
    section('Eckdaten', el('dl', { class: 'facts' }, facts.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))))),
    section('Lage', place(p) && el('div', {}, place(p)),
      maps && el('a', { href: maps, target: '_blank', rel: 'noopener noreferrer' }, 'In Google Maps öffnen')),
    section('Suchprofile', p.profiles.map(profileLine)),
    section('Besichtigungs-Checkliste', (p.checklist || []).map((c) => el('div', { class: 'note' },
      el('div', {}, el('b', {}, c.state || '–'), ' · ', c.label, c.category ? el('span', { class: 'muted small' }, ` (${c.category})`) : ''),
      c.note ? el('div', { class: 'pre muted small' }, c.note) : null))),
    section('Notizen', p.notes.map((n) => el('div', { class: 'note' },
      el('div', { class: 'pre' }, n.text), el('div', { class: 'muted small' }, date(n.createdAt))))),
    p.renovationNeeds ? section('Sanierungsbedarf', el('div', { class: 'pre' }, p.renovationNeeds)) : null,
    section('Dokumente', el('div', { class: 'docs' }, (p.documents || []).map(documentButton))),
    mailsSection(p.mails),
    section('Beschreibung', p.texts.map((t) => el('details', {},
      el('summary', {}, t.title || 'Text'), el('div', { class: 'pre' }, t.text)))),
    p.features.length ? section('Ausstattung', el('div', { class: 'chips' }, p.features.map((f) => el('span', { class: 'chip' }, f)))) : null,
    section('Links', [...p.portals.map((l) => [l.portal, l.url]), ...p.links.map((l) => [l.name, l.url])]
      .filter(([, url]) => safeUrl(url))
      .map(([name, url]) => el('div', {}, el('a', { href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer' }, name)))),
  ));
}

/** Mails collapsed with their number; automatic mails in their own group. */
function mailsSection(mails) {
  if (!mails.length) return null;
  const mail = (m) => el('details', {},
    el('summary', {}, m.subject, el('span', { class: 'muted small' }, ` · ${m.sender} · ${date(m.sentAt)}`)),
    el('div', { class: 'pre' }, m.body || '(kein Text)'));
  const messages = mails.filter((m) => !m.formality);
  const formalities = mails.filter((m) => m.formality);
  return el('section', { class: 'section' },
    el('details', {},
      el('summary', {}, el('b', {}, `Mails (${mails.length})`)),
      messages.map(mail),
      formalities.length ? el('details', { class: 'group' },
        el('summary', {}, `Formalitäten (${formalities.length}) – Bestätigungen, Widerrufsbelehrungen, Maklerverträge`),
        formalities.map(mail)) : null));
}

function documentButton(d) {
  const sizeText = d.size ? ` (${number.format(d.size / 1024 / 1024)} MB)` : '';
  const button = el('button', {
    onclick: async () => {
      const url = safeUrl(d.url);
      if (!url) return;
      button.disabled = true;
      const label = button.textContent;
      button.textContent = 'Wird geladen …';
      try {
        const response = await fetch(url, { referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(response.status);
        const plain = await decrypt(state.key, new Uint8Array(await response.arrayBuffer()));
        const isPdf = d.name.toLowerCase().endsWith('.pdf');
        const blob = new Blob([plain], { type: isPdf ? 'application/pdf' : 'application/octet-stream' });
        const link = el('a', { href: URL.createObjectURL(blob), download: isPdf ? null : d.name, target: '_blank', rel: 'noopener' });
        document.body.append(link);
        link.click();
        link.remove();
        button.textContent = label;
      } catch (_) {
        button.textContent = 'Konnte nicht geladen werden – erneut versuchen';
      } finally {
        button.disabled = false;
      }
    },
  }, 'Öffnen: ' + d.name + sizeText);
  return button;
}

window.addEventListener('popstate', () => {
  if (state.detail) { state.detail = null; render(); }
});

start();
