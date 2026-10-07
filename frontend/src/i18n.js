import AM_PHRASES from './phrases.am';
import EN_STR from './i18n/en';
import ES_STR from './i18n/es';
import ZH_STR from './i18n/zh';
import AM_STR from './i18n/am';

export const PHRASES = {
  am: AM_PHRASES,
};

export const LOCALES = {
  en: { label: 'English', locale: 'en-US' },
  es: { label: 'Español', locale: 'es-ES' },
  zh: { label: '中文', locale: 'zh-CN' },
  am: { label: 'አማርኛ', locale: 'am-ET' },
};

const STR = {
  en: EN_STR,
  es: ES_STR,
  zh: ZH_STR,
  am: AM_STR,
};

let currentLang = 'en';
let currentT = STR.en;

export function setLanguage(lang) {
  currentLang = LOCALES[lang] ? lang : 'en';
  currentT = STR[currentLang];
  try {
    localStorage.setItem('tmms_lang', currentLang);
  } catch (_) {
    /* ignore */
  }
  document.documentElement.lang = currentLang;
  installDomTranslator();
  return currentLang;
}

export function getLang() {
  return currentLang;
}

export function getLocale() {
  return LOCALES[currentLang].locale;
}

export function t(key) {
  return currentT[key] ?? STR.en[key] ?? key;
}

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
let domObserver = null;

function normalizePhrase(value) {
  return value.replace(/\s+/g, ' ').trim();
}

const COMPOSITE_SEPARATORS = [' / ', ' — ', ' – ', ' · ', ' → ', ' ⋯ '];

function lookupPhrase(map, phrase) {
  if (map[phrase] !== undefined) return map[phrase];
  if (phrase.endsWith(':')) {
    const base = phrase.slice(0, -1).trimEnd();
    if (map[base] !== undefined) return map[base] + ':';
  }
  return undefined;
}

// Translates composite labels (breadcrumbs, "Pass / Yes") by translating each
// segment independently, leaving untranslatable segments (e.g. "TMMS") as-is.
function translateComposite(map, phrase) {
  for (const sep of COMPOSITE_SEPARATORS) {
    if (!phrase.includes(sep)) continue;
    let changed = false;
    const parts = phrase.split(sep).map((part) => {
      const hit = lookupPhrase(map, part.trim());
      if (hit !== undefined && hit !== part.trim()) {
        changed = true;
        return hit;
      }
      return part;
    });
    if (changed) return parts.join(sep);
  }
  return undefined;
}

function translatePhraseValue(value, map, reverse) {
  if (!value) return value;
  const phrase = normalizePhrase(value);
  if (!phrase || reverse.has(phrase)) return value;
  const hit = lookupPhrase(map, phrase) ?? translateComposite(map, phrase);
  if (hit === undefined || hit === phrase) return value;
  const lead = (value.match(/^\s*/) || [''])[0];
  const trail = (value.match(/\s*$/) || [''])[0];
  return lead + hit + trail;
}

function translateTextNodes(root, map, reverse) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentNode;
      if (!parent || SKIP_TAGS.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest && parent.closest('[translate="no"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const next = translatePhraseValue(node.nodeValue, map, reverse);
    if (next !== node.nodeValue) node.nodeValue = next;
    node = walker.nextNode();
  }
}

function translateAttributes(root, map, reverse) {
  const elements = [];
  if (root.nodeType === 1) elements.push(root);
  if (root.querySelectorAll) {
    elements.push(...root.querySelectorAll('[placeholder],[title],[aria-label],[alt]'));
  }
  for (const el of elements) {
    for (const attr of TRANSLATABLE_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const current = el.getAttribute(attr);
      const next = translatePhraseValue(current, map, reverse);
      if (next !== current) el.setAttribute(attr, next);
    }
  }
}

// Translates hardcoded UI strings in place for languages that ship a phrase
// map. Safe to call repeatedly; the observer is installed only once.
export function installDomTranslator() {
  if (typeof document === 'undefined' || !document.body) return;
  const map = PHRASES[currentLang];
  if (!map) {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    return;
  }
  const reverse = new Set(Object.values(map));
  const apply = (root) => {
    translateTextNodes(root, map, reverse);
    translateAttributes(root, map, reverse);
  };
  apply(document.body);
  if (domObserver) return;
  domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const target = mutation.target;
        const next = translatePhraseValue(target.nodeValue, map, reverse);
        if (next !== target.nodeValue) target.nodeValue = next;
      } else if (mutation.type === 'attributes') {
        const el = mutation.target;
        const current = el.getAttribute(mutation.attributeName);
        const next = translatePhraseValue(current, map, reverse);
        if (next !== current) el.setAttribute(mutation.attributeName, next);
      } else {
        for (const node of mutation.addedNodes) apply(node);
      }
    }
  });
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRS,
  });
}


// Load stored language once at module init.
try {
  const stored = localStorage.getItem('tmms_lang');
  if (stored && LOCALES[stored]) setLanguage(stored);
} catch (_) {
  /* ignore */
}
