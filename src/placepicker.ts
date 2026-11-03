import { fetchPlaces } from './api';
import { fold, h } from './dom';
import type { Place } from './plan';

export interface PlacePickerOptions {
  id: string;
  label: string;
  placeholder: string;
  value: Place | null;
  text: string;
  locate?: boolean;
  /** extra button at the end of the box (the To box gets the swap button) */
  trailing?: HTMLElement | null;
  /** Towns with pick-up points, matched instantly without a network call */
  localPlaces: () => Place[];
  onText(text: string): void;
  onPick(place: Place | null): void;
}

/** Text field with place suggestions (towns with pick-up points first, then any address or place). */
export function createPlacePicker(o: PlacePickerOptions) {
  const listId = `${o.id}-list`;
  const input = h('input', {
    id: o.id,
    type: 'text',
    placeholder: o.placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
  });
  input.value = o.value?.label ?? o.text;
  const clear = h('button', { type: 'button', class: 'place-clear', 'aria-label': `Clear ${o.label.toLowerCase()}`, hidden: !input.value }, '×');
  const list = h('ul', { id: listId, class: 'suggestions', role: 'listbox', hidden: true });
  const status = h('p', { class: 'place-status', role: 'status' });
  let current: Place | null = o.value;
  let items: Place[] = [];
  let active = -1;
  let timer = 0;
  let seq = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((p, i) =>
        h(
          'li',
          {
            id: `${listId}-${i}`,
            role: 'option',
            'aria-selected': String(i === active),
            class: i === active ? 'active' : null,
            onmousedown: (e: Event) => {
              e.preventDefault(); // keep focus in the input
              pick(p);
            },
          },
          h('span', { class: 'sugg-label' }, p.label),
          p.detail ? h('span', { class: 'sugg-detail' }, p.detail) : null,
        ),
      ),
    );
    list.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const pick = (p: Place | null) => {
    current = p;
    input.value = p?.label ?? '';
    clear.hidden = !input.value;
    status.textContent = '';
    close();
    o.onPick(p);
  };

  const suggest = async (q: string) => {
    const mine = ++seq;
    const f = fold(q);
    const local = f ? o.localPlaces().filter((p) => fold(p.label).includes(f)).slice(0, 4) : [];
    items = local;
    active = -1;
    render();
    if (q.trim().length < 3) return;
    el.classList.add('searching'); // a light sweeps under the box while places are looked up
    try {
      const remote = await fetchPlaces(q);
      if (mine !== seq) return; // a newer search started
      const extra = remote.filter((r) => !local.some((l) => fold(l.label) === fold(r.label) && Math.abs(l.lat - r.lat) < 0.15));
      items = [...local, ...extra].slice(0, 7);
      render();
    } catch {
      if (mine === seq && !items.length) status.textContent = 'Place search isn’t answering. Try a town with a pick-up point.';
    } finally {
      if (mine === seq) el.classList.remove('searching');
    }
  };

  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    status.textContent = '';
    if (current && input.value !== current.label) {
      current = null;
      o.onPick(null);
    }
    o.onText(input.value);
    clearTimeout(timer);
    timer = window.setTimeout(() => void suggest(input.value), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) pick(items[Math.max(active, 0)]);
      else if (input.value.trim().length >= 2) {
        // Nothing suggested yet: search now and take the best match
        void suggest(input.value).then(() => items.length && pick(items[0]));
      }
    } else if (e.key === 'Escape' && !list.hidden) {
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(close, 120));
  input.addEventListener('focus', () => {
    if (!current && input.value.trim()) void suggest(input.value);
  });
  clear.addEventListener('click', () => {
    o.onText('');
    pick(null);
    input.focus();
  });

  const locateBtn = o.locate
    ? h(
        'button',
        {
          type: 'button',
          class: 'icon-btn locate',
          'aria-label': 'Use my current location',
          title: 'Use my current location',
          onclick: () => {
            if (!('geolocation' in navigator)) {
              status.textContent = 'This browser can’t share your location. Type a town instead.';
              return;
            }
            status.textContent = 'Finding you…';
            navigator.geolocation.getCurrentPosition(
              (pos) => pick({ label: 'My location', detail: 'From your device', lat: pos.coords.latitude, lon: pos.coords.longitude }),
              (err) => {
                status.textContent = err.code === err.PERMISSION_DENIED ? 'Location access was blocked. Type a town instead.' : 'Couldn’t get your location. Type a town instead.';
              },
              { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
            );
          },
        },
        locateIcon(),
      )
    : null;

  const el = h(
    'div',
    { class: 'field place-field' },
    h('label', { class: 'field-label', for: o.id }, o.label),
    h('div', { class: 'place-input' }, input, clear, locateBtn, o.trailing ?? null),
    list,
    status,
  );
  return { el, input };
}

function locateIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}
