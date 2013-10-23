/***
Spectrum: The No Hassle Colorpicker
https://github.com/bgrins/spectrum

Author: Brian Grinstead
License: MIT
***/

"use strict";

/**
 * Spectrum creates a color picker widget in any container you give it.
 *
 * Simple usage example:
 *
 * const {Spectrum} = require("devtools/shared/widgets/Spectrum");
 * let s = new Spectrum(containerElement, [255, 126, 255, 1]);
 * s.addChangeListener(color => {
 *   console.log("rgba(" + color[0] + ", " + color[1] + ", " + color[2] + ", " + color[3] + ")");
 * });
 * s.show();
 * s.destroy();
 *
 * Note that the color picker is hidden by default and you need to call show to
 * make it appear. This 2 stages initialization helps in cases you are creating
 * the color picker in a parent element that hasn't been appended anywhere yet
 * or that is hidden. Calling show() when the parent element is appended and
 * visible will allow spectrum to correctly initialize its various parts.
 */
function Spectrum(parentEl, rgb) {
  this.element = parentEl.ownerDocument.createElement('div');
  this.parentEl = parentEl;

  this.element.className = "spectrum-container";
  this.element.innerHTML = [
    "<div class='spectrum-top'>",
      "<div class='spectrum-fill'></div>",
      "<div class='spectrum-top-inner'>",
        "<div class='spectrum-color'>",
          "<div class='spectrum-sat'>",
            "<div class='spectrum-val'>",
              "<div class='spectrum-dragger'></div>",
            "</div>",
          "</div>",
        "</div>",
        "<div class='spectrum-hue'>",
          "<div class='spectrum-slider'></div>",
        "</div>",
      "</div>",
    "</div>",
    "<div class='spectrum-range-container'>",
      "<input type='range' class='spectrum-range' min='0' max='100' />",
    "</div>"
  ].join("");

  this.onElementClick = this.onElementClick.bind(this);
  this.element.addEventListener("click", this.onElementClick, false);

  this.parentEl.appendChild(this.element);

  this.slider = this.element.querySelectorAll(".spectrum-hue")[0];
  this.slideHelper = this.element.querySelectorAll(".spectrum-slider")[0];
  Spectrum.draggable(this.slider, this.onSliderMove.bind(this));

  this.dragger = this.element.querySelectorAll(".spectrum-color")[0];
  this.dragHelper = this.element.querySelectorAll(".spectrum-dragger")[0];
  Spectrum.draggable(this.dragger, this.onDraggerMove.bind(this));

  this.rangeSlider = this.element.querySelectorAll(".spectrum-range")[0];
  this.onRangeSliderChange = this.onRangeSliderChange.bind(this);
  this.rangeSlider.addEventListener("change", this.onRangeSliderChange, false);

  if (rgb) {
    this.rgb = rgb;
    this.updateUI();
  }
}

module.exports.Spectrum = Spectrum;

Spectrum.hsvToRgb = function(h, s, v, a) {
  let r, g, b;

  let i = Math.floor(h * 6);
  let f = h * 6 - i;
  let p = v * (1 - s);
  let q = v * (1 - f * s);
  let t = v * (1 - (1 - f) * s);

  switch(i % 6) {
    case 0: r = v, g = t, b = p; break;
    case 1: r = q, g = v, b = p; break;
    case 2: r = p, g = v, b = t; break;
    case 3: r = p, g = q, b = v; break;
    case 4: r = t, g = p, b = v; break;
    case 5: r = v, g = p, b = q; break;
  }

  return [r * 255, g * 255, b * 255, a];
};

Spectrum.rgbToHsv = function(r, g, b, a) {
  r = r / 255;
  g = g / 255;
  b = b / 255;

  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;

  let d = max - min;
  s = max == 0 ? 0 : d / max;

  if(max == min) {
    h = 0; // achromatic
  }
  else {
    switch(max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, v, a];
};

Spectrum.addEvent = function (el, name, cb) {
  if (typeof name === "object") {
    for (let i in name) {
      el.addEventListener(i, name[i], false);
    }
  } else {
    el.addEventListener(name, cb, false);
  }
};

 Spectrum.removeEvent = function(el, name, cb) {
  if (typeof name === "object") {
    for (let i in name) {
      el.removeEventListener(i, name[i], false);
    }
  } else {
    el.removeEventListener(name, cb, false);
  }
};

Spectrum.getOffset = function(el) {
  let curleft = 0, curtop = 0;
  if (el.offsetParent) {
    do {
      curleft += el.offsetLeft;
      curtop += el.offsetTop;
    } while (el = el.offsetParent);
  }
  return {
    left: curleft,
    top: curtop
  };
};

Spectrum.draggable = function(element, onmove, onstart, onstop) {
  onmove = onmove || function() {};
  onstart = onstart || function() {};
  onstop = onstop || function() {};

  let doc = element.ownerDocument;
  let dragging = false;
  let offset = { };
  let maxHeight = 0;
  let maxWidth = 0;

  let duringDragEvents = {
    selectstart: prevent,
    dragstart: prevent,
    mousemove: move,
    mouseup: stop
  };

  function prevent(e) {
    if (e.stopPropagation) {
      e.stopPropagation();
    }
    if (e.preventDefault) {
      e.preventDefault();
    }
    e.returnValue = false;
  }

  function move(e) {
    if (dragging) {
      let pageX = e.pageX;
      let pageY = e.pageY;

      let dragX = Math.max(0, Math.min(pageX - offset.left, maxWidth));
      let dragY = Math.max(0, Math.min(pageY - offset.top, maxHeight));

      onmove.apply(element, [dragX, dragY]);
    }
  }
  function start(e) {
    let rightclick = (e.which) ? (e.which == 3) : (e.button == 2);

    if (!rightclick && !dragging) {
      if (onstart.apply(element, arguments) !== false) {
        dragging = true;
        maxHeight = element.clientHeight;
        maxWidth = element.clientWidth;

        offset = Spectrum.getOffset(element);

        Spectrum.addEvent(doc, duringDragEvents);

        prevent(e);
      }
    }
  }
  function stop() {
    if (dragging) {
      Spectrum.removeEvent(doc, duringDragEvents);
      onstop.apply(element, arguments);
    }
    dragging = false;
  }

  Spectrum.addEvent(element, "mousedown", start);
};

Spectrum.prototype = {
  set rgb(color) {
    this.hsv = Spectrum.rgbToHsv(color[0], color[1], color[2], color[3]);
  },

  get rgb() {
    let rgb = Spectrum.hsvToRgb(this.hsv[0], this.hsv[1], this.hsv[2], this.hsv[3]);
    return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), rgb[3]];
  },

  get rgbNoSatVal() {
    let rgb = Spectrum.hsvToRgb(this.hsv[0], 1, 1);
    return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), rgb[3]];
  },

  get rgbCssString() {
    let rgb = this.rgb;
    return "rgba(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ", " + rgb[3] + ")";
  },

  show: function() {
    this.element.classList.add('spectrum-show');

    this.slideHeight = this.slider.offsetHeight;
    this.dragWidth = this.dragger.offsetWidth;
    this.dragHeight = this.dragger.offsetHeight;
    this.dragHelperHeight = this.dragHelper.clientHeight;
    this.slideHelperHeight = this.slideHelper.clientHeight;

    this.updateUI();
  },

  onElementClick: function(e) {
    e.stopPropagation();
  },

  onRangeSliderChange: function(e) {
    this.hsv[3] = this.rangeSlider.value / 100;
    this.updateUI();
    this.onchange();
  },

  onSliderMove: function(dragX, dragY) {
    this.hsv[0] = (dragY / this.slideHeight);
    this.updateUI();
    this.onchange();
  },

  onDraggerMove: function(dragX, dragY) {
    this.hsv[1] = dragX / this.dragWidth;
    this.hsv[2] = (this.dragHeight - dragY) / this.dragHeight;
    this.updateUI();
    this.onchange();
  },

  onchange: function() {
    this._onchange(this.rgb, this.rgbCssString);
  },

  _onchange: function() {},

  updateHelperLocations: function() {
    let h = this.hsv[0];
    let s = this.hsv[1];
    let v = this.hsv[2];

    // Where to show the little circle in that displays your current selected color
    let dragX = s * this.dragWidth;
    let dragY = this.dragHeight - (v * this.dragHeight);

    dragX = Math.max(
      -this.dragHelperHeight,
      Math.min(this.dragWidth - this.dragHelperHeight, dragX - this.dragHelperHeight)
    );
    dragY = Math.max(
      -this.dragHelperHeight,
      Math.min(this.dragHeight - this.dragHelperHeight, dragY - this.dragHelperHeight)
    );

    this.dragHelper.style.top = dragY + "px";
    this.dragHelper.style.left = dragX + "px";

    // Where to show the bar that displays your current selected hue
    let slideY = (h * this.slideHeight) - this.slideHelperHeight;
    this.slideHelper.style.top = slideY + "px";

    this.rangeSlider.value = this.hsv[3] * 100;
  },

  updateUI: function() {
    this.updateHelperLocations();

    let rgb = this.rgb;
    let rgbNoSatVal = this.rgbNoSatVal;

    let flatColor = "rgb(" + rgbNoSatVal[0] + ", " + rgbNoSatVal[1] + ", " + rgbNoSatVal[2] + ")";
    let fullColor = "rgba(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ", " + rgb[3] + ")";

    this.dragger.style.backgroundColor = flatColor;

    this.rangeSlider.value = this.hsv[3] * 100;
  },

  addChangeListener: function(listener) {
    this._onchange = listener;
  },

  destroy: function() {
    this.element.removeEventListener("click", this.onElementClick, false);
    this.rangeSlider.removeEventListener("change", this.onRangeSliderChange, false);

    this.parentEl.removeChild(this.element);

    this.slider = null;
    this.dragger = null;
    this.rangeSlider = null;
    this.parentEl = null;
    this.element = null;
  }
};