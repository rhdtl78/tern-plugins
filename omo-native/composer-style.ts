import { attachmentsCss } from "./attachments";

export const composerCss = `
    .sf-col[data-id="composer"][data-role="omp.editor"] {
      --omo-composer-edge: 1px;
      --omo-composer-inset: 12px;
      --omo-feedback-gap: 10px;
      --omo-composer-row-gap: 4px;
      --omo-mode-teal: light-dark(#007d71, #31c4ae);
      --omo-mode-violet: light-dark(#7751a6, #b597e0);
      --omo-mode-research: light-dark(#356ca6, #83ace0);
      background: var(--raise);
      border: var(--omo-composer-edge) solid var(--l3);
      border-radius: 22px;
      box-shadow: none;
      gap: var(--omo-composer-row-gap);
      padding: var(--omo-composer-inset);
    }
    .sf-col[data-id="composer"][data-role="omp.editor"]::before,
    .sf-col[data-id="composer"][data-role="omp.editor"]::after { display: none; }
    .sf-col[data-id="composer"][data-role="omp.editor"]:focus-within {
      border-color: var(--accent);
    }
    .sf-col[data-id="composer"]:has([data-id="composer-mode"][data-role="ulw-preview"]),
    .sf-col[data-id="composer"]:has([data-id="composer-mode"][data-role="ulw-running"]) {
      --omo-mode-start: var(--omo-mode-teal);
      --omo-mode-end: var(--omo-mode-violet);
    }
    .sf-col[data-id="composer"]:has([data-id="composer-mode"][data-role="research-preview"]) {
      --omo-mode-start: var(--omo-mode-research);
      --omo-mode-end: var(--omo-mode-research);
    }
    .sf-col[data-id="composer"]:has([data-id="composer-mode"]:not([data-role="normal"])) {
      border-color: transparent;
      background: linear-gradient(var(--raise), var(--raise)) padding-box,
        linear-gradient(to right, var(--omo-mode-start), var(--omo-mode-end)) border-box;
    }
    .sf-col[data-id="composer"]:has([data-id="composer-mode"][data-role="ulw-running"]) {
      box-shadow: inset 0 0 0 var(--omo-composer-edge) var(--omo-mode-teal);
    }
    .sf-col[data-id="composer"] > .sf-row[data-id="session-feedback"] {
      position: absolute;
      bottom: calc(100% + var(--omo-feedback-gap) + var(--omo-composer-edge));
      left: 22px;
      pointer-events: none;
    }
    .sf-col[data-id="dock"]:has([data-id^="pending."]) .sf-row[data-id="session-feedback"] {
      position: static;
    }
    .sf-scroll[data-id="pending-messages"] {
      align-self: center;
      width: min(100%, 736px);
      border: 1px solid var(--l3);
      border-radius: 12px;
      padding: 4px 10px;
    }
    .sf-text[data-id^="pending."] {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .sf-text[data-id="session-background-counts"] {
      color: var(--t2);
      font-size: .875em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .sf-col[data-id="composer"][data-role="omp.editor"] > .sf-row[data-id="line"] {
      min-height: 0;
      padding: 0;
    }
    .sf-col[data-id="composer"][data-role="omp.editor"] > .sf-row[data-id="line"] > .sf-editor[data-id="draft"] {
      min-height: 0;
    }
    .sf-col[data-id="composer"] .sf-editor[data-id="draft"] .sf-ed-ph { color: var(--t2); }
    .sf-col[data-id="composer"][data-role="omp.editor"] > .sf-row[data-id="footer"] {
      --omo-footer-action-size: 28px;
      gap: var(--omo-composer-row-gap);
      margin: 0;
    }
    .sf-row[data-id="footer"] > .sf-place {
      /* A wrapped line can contain the spacer, directory, and action. */
      max-width: calc(100% - var(--omo-footer-action-size) - 2 * var(--omo-composer-row-gap));
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="model"] {
      border: 1px solid var(--l3);
      border-radius: 999px;
      min-width: 0;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="model"] .sf-btn-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sf-row[data-id="footer"] > .sf-button:is([data-id="send"], [data-id="stop"]) {
      background: var(--t1);
      color: var(--raise);
      border: none;
      border-radius: 50%;
      width: var(--omo-footer-action-size);
      height: var(--omo-footer-action-size);
      padding: 0;
      flex: 0 0 var(--omo-footer-action-size);
      margin-left: auto;
      order: 1;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="stop"]:hover {
      background: var(--t2);
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="stop"]::before {
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="send"] {
      background: var(--accent-fill);
      color: #fff;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="send"]:hover { opacity: .9; }
    ${attachmentsCss}
`;
