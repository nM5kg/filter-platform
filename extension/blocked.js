// blocked.html logic — runs as an extension page (chrome-extension://).
// The blocked domain comes from the ?d= query param, set by the DNR
// redirect rule in background.js (one rule per blocked domain). The policy
// name comes from chrome.storage.local (synced policy). If ?d= is ever
// missing (e.g. a Chrome change strips the query from an extensionPath
// redirect), the page still shows a generic block message — the domain
// line just reads "—".
(function () {
  var params = new URLSearchParams(location.search);
  var domain = params.get('d') || '';
  var domainEl = document.getElementById('blocked-domain');
  if (domainEl) domainEl.textContent = domain || '—';

  var policyEl = document.getElementById('policy-name');
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['fpPolicy', 'fpStatus']).then(function (s) {
      var name = (s.fpPolicy && s.fpPolicy.name) || (s.fpStatus && s.fpStatus.policyName) || '';
      if (policyEl) policyEl.textContent = name || '—';
    }).catch(function () {
      if (policyEl) policyEl.textContent = '—';
    });
  } else if (policyEl) {
    policyEl.textContent = '—';
  }

  var back = document.getElementById('back-btn');
  if (back) back.addEventListener('click', function () { history.back(); });
})();
