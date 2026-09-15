// DOM wiring for the demo page. All protocol and validation logic lives in
// mcp-client.js so it can be tested without a browser.
import { McpBrowserClient, validateSelection } from '/mcp-client.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { el.hidden = !on; };

const ENDPOINT = '/mcp';
$('endpoint').textContent = new URL(ENDPOINT, location.origin).href;

const client = new McpBrowserClient(ENDPOINT);
let options = { cities: [], units: [] };

const fillSelect = (el, items, placeholder) => {
  el.innerHTML = '';
  const blank = new Option(placeholder, '');
  blank.disabled = true;
  blank.selected = true;
  el.add(blank);
  for (const it of items) el.add(new Option(it.label, it.value));
};

const clearErrors = () => { $('cityErr').textContent = ''; $('unitErr').textContent = ''; };

const fail = (el, message) => { el.textContent = message; show(el); };

/** Step 1: ask with no arguments, exactly as an agent would. */
async function begin() {
  try {
    await client.initialize();
    const next = await client.startWeatherRequest();

    if (next.kind === 'weather') {
      renderResult({ headline: `Weather in ${next.structured.city}: ${next.structured.temperature}°`, detail: '' });
      return;
    }

    options = {
      cities: next.cities.length ? next.cities : [],
      units: next.units.length ? next.units : [{ value: 'C', label: 'Celsius (°C)' }, { value: 'F', label: 'Fahrenheit (°F)' }],
    };

    show($('assistantMsg'));
    $('assistantText').textContent = 'I need a few details to check the weather.';
    fillSelect($('city'), options.cities, 'Choose a city…');
    fillSelect($('unit'), options.units, 'Choose a unit…');
    show($('form'));
  } catch (err) {
    fail($('fatal'), 'Could not reach the MCP server: ' + err.message);
  }
}

/** Step 2: send what the user picked and show the reading. */
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();
  show($('error'), false);

  const values = { city: $('city').value, unit: $('unit').value };
  const errors = validateSelection(values, options);
  if (Object.keys(errors).length) {
    if (errors.city) $('cityErr').textContent = errors.city;
    if (errors.unit) $('unitErr').textContent = errors.unit;
    return;
  }

  const submit = $('submit');
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    renderResult(await client.submitWeatherRequest(values));
    show($('form'), false);
  } catch (err) {
    fail($('error'), err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
});

$('cancel').addEventListener('click', () => {
  show($('form'), false);
  show($('result'), false);
  show($('error'), false);
  $('assistantText').textContent = 'Weather request cancelled by the user.';
});

function renderResult({ headline, detail }) {
  $('resultBig').textContent = headline;
  $('resultSub').textContent = detail;
  show($('result'));
}

begin();
