(function () {
  'use strict';
  var IDX = __IDX__;
  var COPYBTN = __COPY__;
  var T = __T__;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function ph(s) { return esc(s).replace(/\[([^\]]+)\]/g, '<span class="ph">$&</span>'); }

  var toast = document.getElementById('toast');
  var timer;
  function say(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { toast.hidden = true; }, 2600);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text, btn) {
    function finish(ok) {
      if (ok) {
        btn.classList.add('done');
        say(/\[/.test(text) ? T.copiedBracket : T.copied);
        setTimeout(function () { btn.classList.remove('done'); }, 1800);
      } else {
        say(T.copyFail);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(fallbackCopy(text)); });
    } else {
      finish(fallbackCopy(text));
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.copy');
    if (b) {
      var box = b.closest('.pr');
      copyText(box.querySelector('.ptxt').textContent.trim(), b);
      return;
    }
    var a = e.target.closest('a[href^="#"]');
    if (a) {
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (el) {
        e.preventDefault();
        var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      }
    }
  });

  var q = document.getElementById('q');
  var res = document.getElementById('res');
  function render() {
    var v = q.value.trim().toLowerCase();
    res.textContent = '';
    if (!v) { res.hidden = true; return; }
    var terms = v.split(/\s+/).map(function (t) { return t.length > 3 ? t.replace(/s$/, '') : t; });
    var hits = IDX.filter(function (x) {
      var hay = (x.t + ' ' + x.a + ' ' + x.n).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) > -1; });
    });
    res.hidden = false;
    var head = document.createElement('p');
    head.className = 'rh';
    head.textContent = hits.length
      ? (hits.length === 1 ? T.found1 : T.foundN.replace('{n}', hits.length)) + (hits.length > 20 ? T.first20 : '')
      : T.none;
    res.appendChild(head);
    hits.slice(0, 20).forEach(function (x) {
      var w = document.createElement('div');
      w.className = 'ri';
      w.innerHTML = '<a class="ra" href="#' + x.id + '">' + esc(x.a) + '</a>' +
        '<div class="pr"><p class="ptxt">' + ph(x.t) + '</p>' + (x.n ? '<span class="tag">' + esc(x.n) + '</span>' : '') + COPYBTN + '</div>';
      res.appendChild(w);
    });
  }
  q.addEventListener('input', render);

  var fab = document.getElementById('fab');
  var hero = document.querySelector('.hero');
  function tick() { fab.classList.toggle('on', hero.getBoundingClientRect().bottom < 0); }
  window.addEventListener('scroll', tick, { passive: true });
  tick();
})();
