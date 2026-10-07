(function () {
  "use strict";

  // The menu is a fixed run of pages. Reaching the last one sends the reader
  // back to the top rather than stopping, so scrolling feels endless without
  // the DOM having to be endless.
  var WRAP_EPSILON = 2; // px past the end that still counts as "at the bottom"
  var WRAP_COOLDOWN = 700; // ms

  var deck = document.getElementById("deck");
  var status = document.getElementById("status");
  var pageCounter = document.getElementById("page-counter");
  var deckEnd = document.getElementById("deck-end");
  var backToTop = document.getElementById("back-to-top");
  var lightbox = document.getElementById("lightbox");
  var lightboxStage = document.getElementById("lightbox-stage");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxClose = lightbox.querySelector(".lightbox__close");

  var manifest = null;
  var ticking = false;
  var suppressWrapUntil = 0;

  /* ------------------------------------------------------------------ */
  /* page construction                                                    */
  /* ------------------------------------------------------------------ */

  function pageData(index) {
    return manifest.pages[index - 1];
  }

  // vercel.json serves assets/pages/ immutable for a year under fixed
  // filenames, so a re-rendered menu would otherwise never reach anyone who
  // scanned before it. The manifest carries a hash of the PDF; tagging it on
  // changes every image URL when the menu changes. A manifest without a
  // version still works, it just behaves the way it did before this existed.
  function versioned(path) {
    return manifest.version ? path + "?v=" + manifest.version : path;
  }

  function createPage(index) {
    var data = pageData(index);
    var figure = document.createElement("figure");
    figure.className = "page";
    figure.dataset.index = String(index);
    // The blurred placeholder sits on the figure rather than the image. The
    // image starts at opacity 0 while it loads, so a placeholder underneath it
    // would be hidden too and the page would read as an empty grey box.
    figure.style.backgroundImage = 'url("' + data.placeholder + '")';

    var img = document.createElement("img");
    img.alt = data.alt;
    img.width = data.width;
    img.height = data.height;
    img.decoding = "async";
    img.setAttribute("loading", "lazy");
    img.sizes = "(max-width: 900px) 100vw, 900px";
    img.dataset.large = versioned(data.large);

    // Sources are set up front and native lazy loading defers the fetch. This
    // used to hang off an IntersectionObserver callback, which meant a browser
    // that never delivered that callback left every page permanently invisible.
    img.srcset =
      versioned(data.small) + " " + data.width + "w, " +
      versioned(data.large) + " " + data.largeWidth + "w";
    img.src = versioned(data.small);

    // Fade in once the pixels are there, but never stay invisible on failure:
    // a 404 has to leave the placeholder showing, not a blank rectangle.
    var reveal = function () {
      img.classList.add("is-loaded");
    };
    img.addEventListener("load", reveal);
    img.addEventListener("error", reveal);

    figure.appendChild(img);
    return figure;
  }

  /* ------------------------------------------------------------------ */
  /* page flow                                                            */
  /* ------------------------------------------------------------------ */

  function renderRange(from, to) {
    var frag = document.createDocumentFragment();
    for (var i = from; i <= to; i++) frag.appendChild(createPage(i));
    return frag;
  }

  // The page under the middle of the viewport is the one being read.
  function currentIndex() {
    var mid = window.innerHeight / 2;
    var kids = deck.children;
    for (var i = 0; i < kids.length; i++) {
      var rect = kids[i].getBoundingClientRect();
      if (rect.top <= mid && rect.bottom >= mid) {
        return Number(kids[i].dataset.index);
      }
    }
    return 0;
  }

  function atBottom() {
    var doc = document.documentElement;
    // If the whole menu fits on screen there is no end to wrap from, and
    // top and bottom are the same place.
    if (doc.scrollHeight <= window.innerHeight + 1) return false;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - WRAP_EPSILON;
  }

  // Instant, not smooth: this is often fifteen thousand pixels of scrolling,
  // and animating it is nauseating rather than helpful.
  function wrapToTop() {
    suppressWrapUntil = Date.now() + WRAP_COOLDOWN;
    window.scrollTo(0, 0);
  }

  function updateCounter() {
    var index = currentIndex();
    if (index) {
      pageCounter.textContent = "Page " + index + " of " + manifest.pageCount;
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      if (!lightbox.hidden) return;

      updateCounter();

      // Momentum scrolling keeps firing events after the jump, and on iOS it
      // keeps travelling too, so without the cooldown the page can bounce.
      if (atBottom() && Date.now() >= suppressWrapUntil) {
        wrapToTop();
        // Re-read rather than wait for the scroll event this jump will fire:
        // scrollY is already updated, and the counter must never disagree
        // with where the reader is.
        updateCounter();
      }
    });
  }

  backToTop.addEventListener("click", wrapToTop);

  /* ------------------------------------------------------------------ */
  /* zoom lightbox                                                         */
  /* ------------------------------------------------------------------ */

  var MIN_SCALE = 1;
  var MAX_SCALE = 4;
  var DOUBLE_TAP_SCALE = 2.5;

  var view = { scale: 1, x: 0, y: 0 };
  var pointers = new Map();
  var lastTapTime = 0;
  var lastTapX = 0;
  var lastTapY = 0;
  var dragMoved = false;
  var pinchStart = null;
  var savedScrollY = 0;

  function applyTransform() {
    lightboxImg.style.transform =
      "translate(" + view.x + "px, " + view.y + "px) scale(" + view.scale + ")";
  }

  function clampView() {
    var stageW = lightboxStage.clientWidth;
    var stageH = lightboxStage.clientHeight;
    var baseW = lightboxImg.offsetWidth;
    var baseH = lightboxImg.offsetHeight;

    var maxX = Math.max(0, (baseW * view.scale - stageW) / 2);
    var maxY = Math.max(0, (baseH * view.scale - stageH) / 2);

    view.x = Math.min(maxX, Math.max(-maxX, view.x));
    view.y = Math.min(maxY, Math.max(-maxY, view.y));
  }

  function resetView() {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    applyTransform();
  }

  // Keep the content point under (cx, cy) pinned while the scale changes.
  function zoomToPoint(nextScale, cx, cy) {
    nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    var stageW = lightboxStage.clientWidth;
    var stageH = lightboxStage.clientHeight;
    var px = cx - stageW / 2;
    var py = cy - stageH / 2;
    var ratio = nextScale / view.scale;
    view.x = view.x * ratio - px * (ratio - 1);
    view.y = view.y * ratio - py * (ratio - 1);
    view.scale = nextScale;
    if (view.scale === 1) {
      view.x = 0;
      view.y = 0;
    }
    clampView();
    applyTransform();
  }

  function openLightbox(img) {
    var figure = img.closest(".page");
    var data = figure ? pageData(Number(figure.dataset.index)) : null;
    lightboxImg.src = data ? versioned(data.large) : img.dataset.large;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
    resetView();

    savedScrollY = window.scrollY;
    document.documentElement.style.overflow = "hidden";
    lightboxClose.focus();
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute("src");
    pointers.clear();
    pinchStart = null;
    document.documentElement.style.overflow = "";
    // Landing back at the very bottom would otherwise trip the wrap check
    // before the reader has even let go of the zoomed page.
    suppressWrapUntil = Date.now() + WRAP_COOLDOWN;
    window.scrollTo(0, savedScrollY);
  }

  deck.addEventListener("click", function (event) {
    var img = event.target;
    if (img.tagName !== "IMG") return;
    openLightbox(img);
  });

  lightboxClose.addEventListener("click", closeLightbox);

  lightbox.addEventListener("click", function (event) {
    // Only a tap on the backdrop itself closes, never a drag on the image.
    if (event.target !== lightbox && event.target !== lightboxStage) return;
    if (view.scale > 1 || dragMoved) return;
    closeLightbox();
  });

  document.addEventListener("keydown", function (event) {
    if (lightbox.hidden) return;
    if (event.key === "Escape") closeLightbox();
  });

  lightboxStage.addEventListener("pointerdown", function (event) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    lightboxStage.setPointerCapture(event.pointerId);
    dragMoved = false;

    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinchStart = {
        distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        scale: view.scale
      };
    }
  });

  lightboxStage.addEventListener("pointermove", function (event) {
    if (!pointers.has(event.pointerId)) return;
    var prev = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchStart) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStart.distance > 0) {
        zoomToPoint(pinchStart.scale * (d / pinchStart.distance), event.clientX, event.clientY);
      }
      dragMoved = true;
      return;
    }

    if (view.scale > 1) {
      view.x += event.clientX - prev.x;
      view.y += event.clientY - prev.y;
      clampView();
      applyTransform();
      if (Math.abs(event.clientX - prev.x) + Math.abs(event.clientY - prev.y) > 4) {
        dragMoved = true;
      }
    }
  });

  function releasePointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
  }

  lightboxStage.addEventListener("pointerup", releasePointer);
  lightboxStage.addEventListener("pointercancel", releasePointer);

  lightboxStage.addEventListener("click", function (event) {
    var now = Date.now();
    var dx = Math.abs(event.clientX - lastTapX);
    var dy = Math.abs(event.clientY - lastTapY);
    var isDoubleTap = now - lastTapTime < 300 && dx < 30 && dy < 30;
    lastTapTime = now;
    lastTapX = event.clientX;
    lastTapY = event.clientY;

    if (isDoubleTap) {
      var rect = lightboxStage.getBoundingClientRect();
      if (view.scale > 1) {
        resetView();
      } else {
        zoomToPoint(DOUBLE_TAP_SCALE, event.clientX - rect.left, event.clientY - rect.top);
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                 */
  /* ------------------------------------------------------------------ */

  // The manifest deliberately lives outside assets/pages/. vercel.json marks
  // everything in there as immutable for a year, and a manifest that stale pins
  // the paths it lists -- so a corrected menu could never reach anyone who had
  // cached the old one. Do not move this back into assets/pages/.
  fetch("assets/menu.json")
    .then(function (response) {
      if (!response.ok) throw new Error("manifest " + response.status);
      return response.json();
    })
    .then(function (data) {
      manifest = data;
      document.documentElement.style.setProperty("--ar", data.aspectRatio);

      deck.appendChild(renderRange(1, data.pageCount));

      status.hidden = true;
      pageCounter.hidden = false;
      deckEnd.hidden = false;

      window.addEventListener("scroll", onScroll, { passive: true });
      // A reload can restore the reader mid-menu, so seed the counter from
      // wherever they actually are rather than assuming page 1.
      onScroll();
    })
    .catch(function (error) {
      status.className = "status status--error";
      status.textContent =
        "Could not load the menu. Please refresh, or call +281-760-5675 to order.";
      console.error(error);
    });
})();