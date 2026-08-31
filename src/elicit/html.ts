import { labelFor, normalizeOptions, type FieldSpec } from './fields.js';

/**
 * Everything the form page needs to draw itself. Kept structural so both the
 * blocking in-memory prompt and a stored ticket satisfy it without conversion.
 */
export interface PromptView {
  title: string;
  message: string;
  token: string;
  fields: FieldSpec[];
  details?: string;
  risk?: 'low' | 'medium' | 'high';
  submitLabel?: string;
  cancelLabel?: string;
}

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --card: #ffffff; --fg: #16181d; --muted: #6b7280;
  --border: #e3e6ea; --accent: #4f46e5; --accent-fg: #ffffff;
  --danger: #b42318; --danger-bg: #fef3f2; --danger-border: #fecdca;
  --warn: #b54708; --warn-bg: #fffaeb; --warn-border: #fedf89;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: #171a21; --fg: #e6e8ec; --muted: #9aa1ad;
    --border: #262b34; --accent: #6366f1; --accent-fg: #ffffff;
    --danger: #fda29b; --danger-bg: #2a1614; --danger-border: #5b2220;
    --warn: #fec84b; --warn-bg: #2a2113; --warn-border: #5b4420;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  max-width: 560px; margin: 0 auto; background: var(--card);
  border: 1px solid var(--border); border-radius: 14px; padding: 28px;
  box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
}
h1 { margin: 0 0 6px; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.msg { margin: 0 0 20px; color: var(--muted); }
.details {
  white-space: pre-wrap; word-break: break-word; background: var(--bg);
  border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px;
  margin: 0 0 20px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 320px; overflow: auto;
}
.risk {
  display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .02em;
  text-transform: uppercase; padding: 3px 9px; border-radius: 999px; margin-bottom: 12px;
  border: 1px solid var(--border); color: var(--muted);
}
.risk.high { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
.risk.medium { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }
.errors {
  background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger);
  border-radius: 9px; padding: 10px 14px; margin: 0 0 18px; font-size: 14px;
}
.errors ul { margin: 0; padding-left: 18px; }
.field { margin-bottom: 18px; }
label.top { display: block; font-weight: 550; margin-bottom: 6px; font-size: 14px; }
.req { color: var(--danger); margin-left: 3px; }
.hint { color: var(--muted); font-size: 13px; margin: 5px 0 0; }
input[type=text], input[type=email], input[type=url], input[type=date],
input[type=datetime-local], input[type=number], select, textarea {
  width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px;
  background: var(--bg); color: var(--fg); font: inherit; outline: none;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
textarea { min-height: 96px; resize: vertical; }
.choice { display: flex; align-items: flex-start; gap: 9px; padding: 5px 0; }
.choice input { margin: 3px 0 0; flex: none; accent-color: var(--accent); }
.choice span { font-size: 14px; }
.actions { display: flex; gap: 10px; margin-top: 26px; }
button {
  flex: 1; padding: 10px 16px; border-radius: 9px; font: inherit; font-weight: 550;
  cursor: pointer; border: 1px solid var(--border);
}
button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
button.secondary { background: transparent; color: var(--fg); }
button:hover { filter: brightness(1.06); }
.foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: 20px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body>${body}</body></html>`;
}

export function renderClosedPage(heading: string, message: string): string {
  return page(
    heading,
    `<div class="card"><h1>${escapeHtml(heading)}</h1><p class="msg">${escapeHtml(message)}</p></div>`,
  );
}

function renderField(f: FieldSpec, prior: Record<string, unknown>): string {
  const id = `f_${f.name}`;
  const name = escapeHtml(f.name);
  const raw = prior[f.name];
  const current = raw !== undefined ? raw : f.default;
  const hint = f.description ? `<p class="hint">${escapeHtml(f.description)}</p>` : '';
  const req = f.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  const head = `<label class="top" for="${id}">${escapeHtml(labelFor(f))}${req}</label>`;

  const wrap = (inner: string) => `<div class="field">${head}${inner}${hint}</div>`;

  switch (f.type) {
    case 'boolean': {
      const checked = current === true || current === 'true' || current === 'on' ? ' checked' : '';
      return `<div class="field"><div class="choice">
  <input type="checkbox" id="${id}" name="${name}" value="true"${checked}>
  <span>${escapeHtml(labelFor(f))}${req}</span>
</div>${hint}</div>`;
    }

    case 'number':
    case 'integer': {
      const step = f.type === 'integer' ? '1' : 'any';
      const attrs = [
        f.minimum !== undefined ? `min="${escapeHtml(f.minimum)}"` : '',
        f.maximum !== undefined ? `max="${escapeHtml(f.maximum)}"` : '',
        f.required ? 'required' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const val = current !== undefined ? ` value="${escapeHtml(current)}"` : '';
      return wrap(`<input type="number" step="${step}" id="${id}" name="${name}"${val} ${attrs}>`);
    }

    case 'select': {
      const opts = normalizeOptions(f)
        .map(
          (o) =>
            `<option value="${escapeHtml(o.value)}"${String(current) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
        )
        .join('');
      const blank = f.required && current === undefined ? '<option value="" disabled selected>Choose…</option>' : '';
      return wrap(`<select id="${id}" name="${name}"${f.required ? ' required' : ''}>${blank}${opts}</select>`);
    }

    case 'multiselect': {
      const selected = new Set(
        Array.isArray(current) ? current.map(String) : current !== undefined ? [String(current)] : [],
      );
      const boxes = normalizeOptions(f)
        .map(
          (o, i) =>
            `<div class="choice"><input type="checkbox" id="${id}_${i}" name="${name}" value="${escapeHtml(o.value)}"${selected.has(o.value) ? ' checked' : ''}><label for="${id}_${i}"><span>${escapeHtml(o.label)}</span></label></div>`,
        )
        .join('');
      return `<div class="field">${head}${boxes}${hint}</div>`;
    }

    case 'string':
    default: {
      if (f.multiline) {
        return wrap(
          `<textarea id="${id}" name="${name}"${f.required ? ' required' : ''}>${current !== undefined ? escapeHtml(current) : ''}</textarea>`,
        );
      }
      const type =
        f.format === 'email'
          ? 'email'
          : f.format === 'uri'
            ? 'url'
            : f.format === 'date'
              ? 'date'
              : f.format === 'date-time'
                ? 'datetime-local'
                : 'text';
      const attrs = [
        f.minLength !== undefined ? `minlength="${escapeHtml(f.minLength)}"` : '',
        f.maxLength !== undefined ? `maxlength="${escapeHtml(f.maxLength)}"` : '',
        f.required ? 'required' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const val = current !== undefined ? ` value="${escapeHtml(current)}"` : '';
      return wrap(`<input type="${type}" id="${id}" name="${name}"${val} ${attrs}>`);
    }
  }
}

export function renderFormPage(
  prompt: PromptView,
  errors: string[],
  prior: Record<string, unknown> = {},
): string {
  const riskBadge =
    prompt.risk && prompt.risk !== 'low'
      ? `<div class="risk ${escapeHtml(prompt.risk)}">${escapeHtml(prompt.risk)} risk</div>`
      : '';

  const errorBox = errors.length
    ? `<div class="errors"><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';

  const detailBox = prompt.details ? `<div class="details">${escapeHtml(prompt.details)}</div>` : '';
  const fields = prompt.fields.map((f) => renderField(f, prior)).join('');

  return page(
    prompt.title,
    `<form class="card" method="post" action="">
  <input type="hidden" name="__token" value="${escapeHtml(prompt.token)}">
  ${riskBadge}
  <h1>${escapeHtml(prompt.title)}</h1>
  <p class="msg">${escapeHtml(prompt.message)}</p>
  ${detailBox}
  ${errorBox}
  ${fields}
  <div class="actions">
    <button type="submit" name="__intent" value="decline" class="secondary">${escapeHtml(prompt.cancelLabel ?? 'Cancel')}</button>
    <button type="submit" name="__intent" value="accept" class="primary">${escapeHtml(prompt.submitLabel ?? 'Continue')}</button>
  </div>
  <p class="foot">Requested by an AI agent via MCP · this page is served locally</p>
</form>`,
  );
}
