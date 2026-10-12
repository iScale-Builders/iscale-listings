'use strict';

var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/highlight.ts
var HIGHLIGHT_CLASS = "iscale-tm-highlight";
var MATCH_DATA_ATTR = "data-iscale-tm-match";
var HIGH_CONFIDENCE_COLOR = "#ea4800";
var LOW_CONFIDENCE_COLOR = "#f5a623";
function highlight(options) {
  const { elements, matches, onClick } = options;
  if (matches.length === 0 || elements.length === 0) {
    return;
  }
  const MarkJS = loadMarkJS();
  injectStyles();
  const matchMap = /* @__PURE__ */ new Map();
  for (const match of matches) {
    matchMap.set(match.matched_text.toLowerCase(), match);
  }
  const keywords = matches.map((m) => m.matched_text);
  for (const element of elements) {
    const instance = new MarkJS(element);
    instance.mark(keywords, {
      acrossElements: true,
      separateWordSearch: false,
      className: HIGHLIGHT_CLASS,
      each(markElement) {
        const textContent = markElement.textContent ?? "";
        const match = matchMap.get(textContent.toLowerCase());
        if (!match) return;
        markElement.setAttribute(MATCH_DATA_ATTR, JSON.stringify(match));
        const color = match.confidence === "high" ? HIGH_CONFIDENCE_COLOR : LOW_CONFIDENCE_COLOR;
        markElement.style.backgroundColor = color;
        markElement.style.color = "#ffffff";
        markElement.style.borderRadius = "2px";
        markElement.style.padding = "0 2px";
        markElement.style.cursor = onClick ? "pointer" : "default";
        if (onClick) {
          markElement.addEventListener("click", (event) => {
            onClick(match, event);
          });
        }
      }
    });
  }
}
function clearHighlights(elements) {
  const MarkJS = loadMarkJS();
  const targets = elements ?? Array.from(
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)
  ).map((el) => el.parentElement).filter(Boolean);
  const unique = [...new Set(targets)];
  for (const element of unique) {
    const instance = new MarkJS(element);
    instance.unmark({ className: HIGHLIGHT_CLASS });
  }
}
var stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  const style = document.createElement("style");
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      transition: background-color 0.15s ease;
    }
    .${HIGHLIGHT_CLASS}:hover {
      filter: brightness(1.15);
    }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
function loadMarkJS() {
  try {
    const mod = __require("mark.js");
    if (typeof mod === "function") return mod;
    if ("default" in mod && typeof mod.default === "function") return mod.default;
    throw new Error("Could not resolve mark.js constructor");
  } catch {
    throw new Error(
      '@iscale/trademark-checker/highlight requires "mark.js" as a peer dependency. Install it with: npm install mark.js'
    );
  }
}

exports.clearHighlights = clearHighlights;
exports.highlight = highlight;
//# sourceMappingURL=highlight.cjs.map
//# sourceMappingURL=highlight.cjs.map