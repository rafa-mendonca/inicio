/* tracking.js — Academy Rafa Mendonça
   Pixel da Meta (+ GA4 opcional). Ligar no <head> de TODAS as páginas:
   <script src="/tracking.js"></script>  (ajustar o caminho conforme o site) */
(function () {
  var META_PIXEL_ID = "1138373795077016";
  var GA4_ID = ""; // ex.: "G-XXXXXXXXXX" — deixar vazio se não usar GA4

  // ---- Pixel da Meta ----
  if (!window.fbq) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  }
  fbq("init", META_PIXEL_ID);
  fbq("track", "PageView");

  // ---- GA4 (só se tiver ID) ----
  if (GA4_ID) {
    var g = document.createElement("script");
    g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag("js", new Date());
    gtag("config", GA4_ID);
  }

  // ---- Cliques em botões de WhatsApp / compra (Hotmart, Stripe) ----
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a");
    if (!a || !a.href) return;
    var h = a.href;
    if (/wa\.me|whatsapp\.com/i.test(h)) {
      fbq("track", "Contact");
      if (window.gtag) gtag("event", "whatsapp_click", { link_url: h });
    } else if (/hotmart|stripe|checkout/i.test(h)) {
      fbq("track", "InitiateCheckout");
      if (window.gtag) gtag("event", "begin_checkout", { link_url: h });
    }
  }, true);
})();
