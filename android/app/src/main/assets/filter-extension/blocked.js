// blocked.html logic — in-app version (GeckoView port of the v1.2.0 page).
//
// DIFFERENCE from the MV3 extension page: the domain and policy name do
// NOT come from a ?d= query param or chrome.storage. Kotlin loads this
// page as a data: URL and substitutes the placeholders in the <body> tag
// (data-domain="{{DOMAIN}}", data-policy="{{POLICY_NAME}}") before
// loading it, so this script just reads those attributes. If an attribute
// is ever missing (e.g. an unsubstituted placeholder), the page still
// shows a generic block message — the domain/policy line just reads "—".
(function () {
  var body = document.body;
  var domain = (body && body.getAttribute('data-domain')) || '';
  if (domain === '{{DOMAIN}}') domain = '';
  var domainEl = document.getElementById('blocked-domain');
  if (domainEl) domainEl.textContent = domain || '—';

  var policy = (body && body.getAttribute('data-policy')) || '';
  if (policy === '{{POLICY_NAME}}') policy = '';
  var policyEl = document.getElementById('policy-name');
  if (policyEl) policyEl.textContent = policy || '—';

  var back = document.getElementById('back-btn');
  if (back) back.addEventListener('click', function () { history.back(); });
})();
