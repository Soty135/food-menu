(function () {
  "use strict";

  // How many pages to splice in at each edge, and how close to the edge
  // the reader has to get before we do it.
  var BATCH = 6;
  var BUFFER = 4;
  var MAX_CHILDREN = 36;

  var deck = document.getElementById("deck");
  var status = document.getElementById("status");
  var lightbox = document.getElementById("lightbox");
  var lightboxStage = document.getElementById("lightbox-stage");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxClose = lightbox.querySelector(".lightbox__close");

  var manifest = null;
  var firstVirtual = 1; // virtual page number of deck's first child
  var lastVirtual = 1;
  var ticking = false;

  /* ------------------------------------------------------------------ */
  /* page construction                                                    */
  /* ------------------------------------------------------------------ */

  function pageData(virtualIndex) {
    var n = manifest.pageCount;
    var i = ((virtualIndex - 1) % n + n) % n;
    return manifest.pages[i];
  }

  function createPage(virtualIndex) {
    var data = pageData(virtualIndex);
    var figure = document.createElement("figure");
    figure.className = "page";
    figure.dataset.virtual = String(virtualIndex);

    var img = document.createElement("img");
    img.alt = data.alt;
    img.width = data.width;
    img.height = data.height;
    img.decoding = "async";
    img.style.backgroundImage = 'url("' + data.placeholder + '")';
    img.dataset.small = data.small;
    img.dataset.large = data.large;
    img.dataset.smallW = String(data.width);
    img.dataset.largeW = String(data.largeWidth);
    img.sizes = "(max-width: 900px) 100vw, 900px";

    img.addEventListener("load", function () {
      img.classList.add("is-loaded");
    });

    figure.appendChild(img);
    return figure;
  }

  // Lazily attach real image sources only when a page nears the viewport.
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var img = entry.target.querySelector("img");
        loadImage(img);
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "150% 0px", threshold: 0 }
  );

  function loadImage(img) {
    if (!img || img.dataset.small === undefined) return;
    img.srcset =
      img.dataset.small + " " + img.dataset.smallW + "w, " +
      img.dataset.large + " " + img.dataset.largeW + "w";
    img.src = img.dataset.small;
  }

  /* ------------------------------------------------------------------ */
  /* endless scroll                                                        */
  /* ------------------------------------------------------------------ */

  function renderRange(from, to) {
    var frag = document.createDocumentFragment();
    for (var i = from; i <= to; i++) frag.appendChild(createPage(i));
    return frag;
  }

  function anchorVirtual() {
    var mid = window.innerHeight / 2;
    var kids = deck.children;
    for (var i = 0; i < kids.length; i++) {
      var rect = kids[i].getBoundingClientRect();
      if (rect.top <= mid && rect.bottom >= mid) {
        return Number(kids[i].dataset.virtual);
      }
    }
    return firstVirtual;
  }

  function extend() {
    var anchor = anchorVirtual();

    if (anchor - firstVirtual < BUFFER) {
      var from = firstVirtual - BATCH;
      deck.insertBefore(renderRange(from, firstVirtual - 1), deck.firstChild);
      firstVirtual = from;
      // Content appeared above the viewport, so shift the reader's position
      // down by exactly what we added to keep the same page on screen.
      compensate(addHeight(deck, BATCH));
    }

    if (lastVirtual - anchor < BUFFER) {
      var to = lastVirtual + BATCH;
      deck.appendChild(renderRange(lastVirtual + 1, to));
      lastVirtual = to;
      observeNew();
    }

    trim(anchor);
  }

  // Measure the newly prepended pages. aspect-ratio reserves the height up
  // front, so this works before any image data arrives.
  function addHeight(container, count) {
    var total = 0;
    for (var i = 0; i < count; i++) {
      var child = container.children[i];
      if (child) total += child.offsetHeight;
    }
    return total;
  }

  function compensate(delta) {
    if (delta > 0) window.scrollBy(0, delta);
  }

  function observeNew() {
    var kids = deck.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].dataset.observed !== "1") {
        kids[i].dataset.observed = "1";
        observer.observe(kids[i]);
      }
    }
  }

  function trim(anchor) {
    while (deck.children.length > MAX_CHILDREN) {
      var first = deck.firstElementChild;
      var last = deck.lastElementChild;
      var distTop = anchor - firstVirtual;
      var distBottom = lastVirtual - anchor;

      if (distTop >= distBottom) {
        var h = first.offsetHeight;
        first.remove();
        firstVirtual++;
        // Removing content above the viewport: pull the reader up to match.
        window.scrollBy(0, -h);
      } else {
        last.remove();
        lastVirtual--;
      }
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      if (!lightbox.hidden) return;
      extend();
    });
  }

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
    var data = figure ? pageData(Number(figure.dataset.virtual)) : null;
    lightboxImg.src = data ? data.large : img.dataset.large;
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

  fetch("assets/pages/manifest.json")
    .then(function (response) {
      if (!response.ok) throw new Error("manifest " + response.status);
      return response.json();
    })
    .then(function (data) {
      manifest = data;
      document.documentElement.style.setProperty("--ar", data.aspectRatio);

      lastVirtual = data.pageCount;
      deck.appendChild(renderRange(1, data.pageCount));
      observeNew();

      status.hidden = true;
      window.addEventListener("scroll", onScroll, { passive: true });
      extend();
    })
    .catch(function (error) {
      status.className = "status status--error";
      status.textContent =
        "Could not load the menu. Please refresh, or call +281-760-5675 to order.";
      console.error(error);
    });
})();