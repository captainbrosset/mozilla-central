/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cc, Cu, Ci} = require("chrome");
const promise = require("sdk/core/promise");
const IOService = Cc["@mozilla.org/network/io-service;1"]
  .getService(Ci.nsIIOService);
const {Spectrum} = require("devtools/shared/widgets/Spectrum");
const EventEmitter = require("devtools/shared/event-emitter");
const {colorUtils} = require("devtools/css-color");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/devtools/ViewHelpers.jsm");

const GRADIENT_RE = /\b(repeating-)?(linear|radial)-gradient\(((rgb|hsl)a?\(.+?\)|[^\)])+\)/gi;
const BORDERCOLOR_RE = /^border-[-a-z]*color$/ig;
const BORDER_RE = /^border(-(top|bottom|left|right))?$/ig;
const BACKGROUND_IMAGE_RE = /url\([\'\"]?(.*?)[\'\"]?\)/;
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Tooltip widget.
 *
 * This widget is intended at any tool that may need to show rich content in the
 * form of floating panels.
 * A common use case is image previewing in the CSS rule view, but more complex
 * use cases may include color pickers, object inspection, etc...
 *
 * Tooltips are based on XUL (namely XUL arrow-type <panel>s), and therefore
 * need a XUL Document to live in.
 * This is pretty much the only requirement they have on their environment.
 *
 * The way to use a tooltip is simply by instantiating a tooltip yourself and
 * attaching some content in it, or using one of the ready-made content types.
 *
 * A convenient `startTogglingOnHover` method may avoid having to register event
 * handlers yourself if the tooltip has to be shown when hovering over a
 * specific element or group of elements (which is usually the most common case)
 */

/**
 * Contains defaults options for tooltips
 */
function OptionsStore(options) {
  this.defaults = {
    xulTagName: "panel",
    consumeOutsideClick: false,
    closeOnKeys: [27]
  };
  this.options = options || {};
}

OptionsStore.prototype = {
  get: function(name) {
    if (typeof this.options[name] !== "undefined") {
      return this.options[name];
    } else {
      return this.defaults[name];
    }
  }
};

/**
 * The low level structure of a tooltip is a XUL element (a <panel>, although
 * <tooltip> is supported too, it won't have the nice arrow shape).
 */
let PanelFactory = {
  /**
   * Get a new XUL panel instance.
   * @param {XULDocument} doc
   *        The XUL document to put that panel into
   * @param {OptionsStore} options
   *        An options store to get some configuration from
   */
  get: function(doc, options) {
    let xulTagName = options.get("xulTagName");
    let consumeOutsideClick = options.get("consumeOutsideClick");

    // Create the tooltip
    let panel = doc.createElement(xulTagName);
    panel.setAttribute("hidden", true);
    panel.setAttribute("ignorekeys", true);

    if (xulTagName === "panel") {
      panel.setAttribute("consumeoutsideclicks", consumeOutsideClick);
      panel.setAttribute("type", "arrow");
      panel.setAttribute("level", "top");
    }

    panel.setAttribute("class", "devtools-tooltip devtools-tooltip-" + xulTagName);
    doc.querySelector("window").appendChild(panel);

    return panel;
  }
};

/**
 * Tooltip class.
 *
 * Basic usage:
 *   let t = new Tooltip(xulDoc);
 *   t.content = someXulContent;
 *   t.show();
 *   t.hide();
 *   t.destroy();
 *
 * Better usage:
 *   let t = new Tooltip(xulDoc);
 *   t.startTogglingOnHover(container, target => {
 *     if (<condition based on target>) {
 *       t.setImageContent("http://image.png");
 *       return true;
 *     }
 *   });
 *   t.destroy();
 *
 * @param {XULDocument} doc
 *        The XUL document hosting this tooltip
 * @param {Object} options
 *        Optional options that give options to consumers
 *        - consumeOutsideClick {Boolean} Wether the first click outside of the
 *        tooltip should close the tooltip and be consumed or not.
 *        Defaults to false
 *        - xulTagName {String} Should we use a "panel" or a "tooltip".
 *        Defaults to "panel"
 *        - closeOnKeys {Array} An array of key codes that should close the
 *        tooltip. Defaults to [27] (escape key)
 *
 * Fires these events:
 * - shown : when the tooltip is shown
 * - hidden : when the tooltip gets hidden
 * - keypress : when any key gets pressed, with keyCode
 */
function Tooltip(doc, options) {
  EventEmitter.decorate(this);

  this.doc = doc;
  this.options = new OptionsStore(options);
  this.panel = PanelFactory.get(doc, this.options);

  // Used for namedTimeouts in the mouseover handling
  this.uid = "tooltip-" + Date.now();

  // Listen to popupshown to emit a shown event
  this._onPopupShown = event => this.emit("shown");
  this.panel.addEventListener("popupshown", this._onPopupShown, false);

  // Listen to popuphidden to emit a hidden event
  this._onPopupHidden = event => this.emit("hidden");
  this.panel.addEventListener("popuphidden", this._onPopupHidden, false);

  // Listen to keypress events to close the tooltip if configured to do so
  let win = this.doc.querySelector("window");
  this._onKeyPress = event => {
    this.emit("keypress", event.keyCode);
    if (this.options.get("closeOnKeys").indexOf(event.keyCode) !== -1) {
      this.hide();
    }
  };
  win.addEventListener("keypress", this._onKeyPress, false);
}

module.exports.Tooltip = Tooltip;

Tooltip.prototype = {
  /**
   * Show the tooltip. It might be wise to append some content first if you
   * don't want the tooltip to be empty. You may access the content of the
   * tooltip by setting a XUL node to t.content.
   * @param {node} anchor
   *        Which node should the tooltip be shown on
   * @param {string} position
   *        https://developer.mozilla.org/en-US/docs/XUL/PopupGuide/Positioning
   *        Defaults to before_start
   */
  show: function(anchor, position="before_start") {
    this.panel.hidden = false;
    this.panel.openPopup(anchor, position);
  },

  /**
   * Hide the tooltip
   */
  hide: function() {
    this.panel.hidden = true;
    this.panel.hidePopup();
  },

  /**
   * Empty the tooltip's content
   */
  empty: function() {
    while (this.panel.hasChildNodes()) {
      this.panel.removeChild(this.panel.firstChild);
    }
  },

  /**
   * Get rid of references and event listeners
   */
  destroy: function () {
    this.hide();

    this.panel.removeEventListener("popupshown", this._onPopupShown, false);
    this.panel.removeEventListener("popuphidden", this._onPopupHidden, false);
    let win = this.doc.querySelector("window");
    win.removeEventListener("keypress", this._onKeyPress, false);

    this.content = null;
    this.doc = null;

    this.panel.parentNode.removeChild(this.panel);
    this.panel = null;

    if (this._basedNode) {
      this.stopTogglingOnHover();
    }
  },

  /**
   * Show/hide the tooltip when the mouse hovers over particular nodes.
   *
   * 2 Ways to make this work:
   * - Provide a single node to attach the tooltip to, as the baseNode, and
   *   omit the second targetNodeCb argument
   * - Provide a baseNode that is the container of possibly numerous children
   *   elements that may receive a tooltip. In this case, provide the second
   *   targetNodeCb argument to decide wether or not a child should receive
   *   a tooltip.
   *
   * This works by tracking mouse movements on a base container node (baseNode)
   * and showing the tooltip when the mouse stops moving. The targetNodeCb
   * callback is used to know whether or not the particular element being
   * hovered over should indeed receive the tooltip. If you don't provide it
   * it's equivalent to a function that always returns true.
   *
   * Note that if you call this function a second time, it will itself call
   * stopTogglingOnHover before adding mouse tracking listeners again.
   *
   * @param {node} baseNode
   *        The container for all target nodes
   * @param {Function} targetNodeCb
   *        A function that accepts a node argument and returns true or false
   *        to signify if the tooltip should be shown on that node or not.
   *        Additionally, the function receives a second argument which is the
   *        tooltip instance itself, to be used to add/modify the content of the
   *        tooltip if needed. If omitted, the tooltip will be shown everytime.
   * @param {Number} showDelay
   *        An optional delay that will be observed before showing the tooltip.
   *        Defaults to 750ms
   */
  startTogglingOnHover: function(baseNode, targetNodeCb, showDelay = 750) {
    if (this._basedNode) {
      this.stopTogglingOnHover();
    }

    this._basedNode = baseNode;
    this._showDelay = showDelay;
    this._targetNodeCb = targetNodeCb || (() => true);

    this._onBaseNodeMouseMove = this._onBaseNodeMouseMove.bind(this);
    this._onBaseNodeMouseLeave = this._onBaseNodeMouseLeave.bind(this);

    baseNode.addEventListener("mousemove", this._onBaseNodeMouseMove, false);
    baseNode.addEventListener("mouseleave", this._onBaseNodeMouseLeave, false);
  },

  /**
   * If the startTogglingOnHover function has been used previously, and you want
   * to get rid of this behavior, then call this function to remove the mouse
   * movement tracking
   */
  stopTogglingOnHover: function() {
    clearNamedTimeout(this.uid);

    this._basedNode.removeEventListener("mousemove",
      this._onBaseNodeMouseMove, false);
    this._basedNode.removeEventListener("mouseleave",
      this._onBaseNodeMouseLeave, false);

    this._basedNode = null;
    this._targetNodeCb = null;
    this._lastHovered = null;
  },

  _onBaseNodeMouseMove: function(event) {
    if (event.target !== this._lastHovered) {
      this.hide();
      this._lastHovered = null;
      setNamedTimeout(this.uid, this._showDelay, () => {
        this._showOnHover(event.target);
      });
    }
  },

  _showOnHover: function(target) {
    if (this._targetNodeCb && this._targetNodeCb(target, this)) {
      this.show(target);
      this._lastHovered = target;
    }
  },

  _onBaseNodeMouseLeave: function() {
    clearNamedTimeout(this.uid);
    this._lastHovered = null;
  },

  /**
   * Set the content of this tooltip. Will first empty the tooltip and then
   * append the new content element.
   * Consider using one of the set<type>Content() functions instead.
   * @param {node} content
   *        A node that can be appended in the tooltip XUL element
   */
  set content(content) {
    this.empty();
    if (content) {
      this.panel.appendChild(content);
    }
  },

  get content() {
    return this.panel.firstChild;
  },

  /**
   * Fill the tooltip with an image, displayed over a tiled background useful
   * for transparent images.
   * Also adds the image dimension as a label at the bottom.
   */
  setImageContent: function(imageUrl, maxDim=400) {
    // Main container
    let vbox = this.doc.createElement("vbox");
    vbox.setAttribute("align", "center")

    // Transparency tiles (image will go in there)
    let tiles = createTransparencyTiles(this.doc, vbox);

    // Temporary label during image load
    let label = this.doc.createElement("label");
    label.classList.add("devtools-tooltip-caption");
    label.textContent = l10n.strings.GetStringFromName("previewTooltip.image.brokenImage");
    vbox.appendChild(label);

    // Display the image
    let image = this.doc.createElement("image");
    image.setAttribute("src", imageUrl);
    if (maxDim) {
      image.style.maxWidth = maxDim + "px";
      image.style.maxHeight = maxDim + "px";
    }
    tiles.appendChild(image);

    this.content = vbox;

    // Load the image to get dimensions and display it when done
    let imgObj = new this.doc.defaultView.Image();
    imgObj.src = imageUrl;
    imgObj.onload = () => {
      imgObj.onload = null;

      // Display dimensions
      label.textContent = imgObj.naturalWidth + " x " + imgObj.naturalHeight;
      if (imgObj.naturalWidth > maxDim ||
        imgObj.naturalHeight > maxDim) {
        label.textContent += " *";
      }
    }
  },

  /**
   * Fill the tooltip with a new instance of the spectrum color picker widget
   * initialized with the given color, and return a promise that resolves to
   * the instance of spectrum
   */
  setColorPickerContent: function(color) {
    let def = promise.defer();

    // Create an iframe to contain spectrum
    let iframe = this.doc.createElementNS(XHTML_NS, "iframe");
    iframe.setAttribute("transparent", true);
    iframe.setAttribute("width", "210");
    iframe.setAttribute("height", "195");
    iframe.setAttribute("flex", "1");
    iframe.setAttribute("class", "devtools-tooltip-iframe");

    let panel = this.panel;
    let xulWin = this.doc.ownerGlobal;

    // Wait for the load to initialize spectrum
    function onLoad() {
      iframe.removeEventListener("load", onLoad, true);
      let win = iframe.contentWindow.wrappedJSObject;

      let container = win.document.getElementById("spectrum");
      let spectrum = new Spectrum(container, color);

      // Finalize spectrum's init when the tooltip becomes visible
      panel.addEventListener("popupshown", function shown() {
        panel.removeEventListener("popupshown", shown, true);
        spectrum.show();
        def.resolve(spectrum);
      }, true);
    }
    iframe.addEventListener("load", onLoad, true);
    iframe.setAttribute("src", "chrome://browser/content/devtools/spectrum-frame.xhtml");

    // Put the iframe in the tooltip
    this.content = iframe;

    return def.promise;
  },

  /**
   * Exactly the same as the `image` function but takes a css background image
   * value instead : url(....)
   */
  setCssBackgroundImageContent: function(cssBackground, sheetHref, maxDim=400) {
    let uri = getBackgroundImageUri(cssBackground, sheetHref);
    if (uri) {
      this.setImageContent(uri, maxDim);
    }
  },

  setCssGradientContent: function(cssGradient) {
    let tiles = createTransparencyTiles(this.doc);

    let gradientBox = this.doc.createElement("box");
    gradientBox.width = "100";
    gradientBox.height = "100";
    gradientBox.style.background = this.cssGradient;
    gradientBox.style.borderRadius = "2px";
    gradientBox.style.boxShadow = "inset 0 0 4px #333";

    tiles.appendChild(gradientBox)

    this.content = tiles;
  },

  _setSimpleCssPropertiesContent: function(properties, width, height) {
    let tiles = createTransparencyTiles(this.doc);

    let box = this.doc.createElement("box");
    box.width = width + "";
    box.height = height + "";
    properties.forEach(({name, value}) => {
      box.style[name] = value;
    });
    tiles.appendChild(box);

    this.content = tiles;
  },

  setCssColorContent: function(cssColor) {
    this._setSimpleCssPropertiesContent([
      {name: "background", value: cssColor},
      {name: "borderRadius", value: "2px"},
      {name: "boxShadow", value: "inset 0 0 4px #333"},
    ], 50, 50);
  },

  setCssBoxShadowContent: function(cssBoxShadow) {
    this._setSimpleCssPropertiesContent([
      {name: "background", value: "white"},
      {name: "boxShadow", value: cssBoxShadow}
    ], 80, 80);
  },

  setCssBorderContent: function(cssBorder) {
    this._setSimpleCssPropertiesContent([
      {name: "background", value: "white"},
      {name: "border", value: cssBorder}
    ], 80, 80);
  }
};

/**
 * The swatch color picker tooltip class is a specific class meant to be used
 * along with output-parser's generated color swatches.
 * It just wraps a standard Tooltip and sets its content with an instance of a
 * color picker.
 *
 * @param {XULDocument} doc
 *
 * Fires the following events:
 * - shown : same as Tooltip's shown event
 * - hidden : same as Tooltip's hidden event
 * - revert : when the user presses <escape> to close the picker. Listeners
 * will be executed with the previousColor argument, which is the css color
 * value that was used to open the color picker in the first place
 * - commit : when the user presses <enter> to close the picker. Listeners will
 * be executed with the color argument, which is the css color value being
 * picked
 * - changed : when the color changes in the color picker. Same as for commit,
 * the color argument will be passed
 */
function SwatchColorPickerTooltip(doc) {
  EventEmitter.decorate(this);

  this.previousColor = null;
  this.currentColor = null;

  // Creating a tooltip instance
  // This one will consume outside clicks as it makes more sense to let the user
  // close the tooltip by clicking out
  // It will also close on <escape> (27) and <enter> (13)
  this.tooltip = new Tooltip(doc, {
    consumeOutsideClick: true,
    closeOnKeys: [27, 13]
  });

  // Firing revert/commit events on <esc> and <enter> keypresses
  this._onTooltipKeypress = (event, code) => {
    if (code === 27) {
      this.emit("revert", this.previousColor);
    } else if (code === 13) {
      this.emit("commit", this.currentColor);
    }
  };
  this.tooltip.on("keypress", this._onTooltipKeypress);

  // Just relaying these events for convenience
  this._onTooltipShown = () => this.emit("shown");
  this._onTooltipHidden = () => this.emit("hidden");
  this.tooltip.on("shown", this._onTooltipShown);
  this.tooltip.on("hidden", this._onTooltipHidden);

  // Loading spectrum into the tooltip is async, so store the last show request
  // and execute it when spectrum is created
  this._queued = null;

  // Creating a spectrum instance
  this.spectrum = null;
  this.tooltip.setColorPickerContent([0, 0, 0, 1]).then(spectrum => {
    this.spectrum = spectrum;
    if (this._queued) {
      this._setSpectrumOptions(this._queued);
      this._queued = null;
    }
  });
}

module.exports.SwatchColorPickerTooltip = SwatchColorPickerTooltip;

SwatchColorPickerTooltip.prototype = {
  /**
   * Show the color picker on a given element.
   * @param {Object} options
   *        Object with the following properties
   *        - colorSwatch {nsIDOMElement} the element to attach the tooltip to.
   *        This must be a color swatch that has been generated by the output-
   *        parser. It will have its background-color set when the color changes
   *        in the color picker. Also, colorSwatch.nextSibling's textContent
   *        will be changed to the color too.
   *        - color {string} a colorUtils parsable color string
   */
  show: function(options) {
    this.previousColor = options.color;

    this._setSpectrumOptions(options);
    if (!this.spectrum) {
      this._queued = options;
    }
    this.tooltip.show(options.colorSwatch, "topcenter bottomleft");
  },

  hide: function() {
    this.tooltip.hide();
  },

  _setSpectrumOptions: function(options) {
    if (this.spectrum) {
      this.spectrum.rgb = this._colorToRgba(options.color);

      this.spectrum.addChangeListener((rgba, color) => {
        options.colorSwatch.style.backgroundColor = color;
        options.colorSwatch.nextSibling.textContent = color;
        this.currentColor = color;
        this.emit("changed", color);
      });

      this.spectrum.updateUI();
    }
  },

  _colorToRgba: function(color) {
    color = new colorUtils.CssColor(color);
    let rgba = color._getRGBATuple();
    return [rgba.r, rgba.g, rgba.b, rgba.a];
  },

  destroy: function() {
    if (this.spectrum) {
      this.spectrum.destroy();
    }
    this.tooltip.off("shown", this._onTooltipShown);
    this.tooltip.off("hidden", this._onTooltipHidden);
    this.tooltip.off("keypress", this._onTooltipKeypress);
    this.tooltip.destroy();
  }
};

/**
 * Internal utility function that creates a tiled background useful for
 * displaying semi-transparent images
 */
function createTransparencyTiles(doc, parentEl) {
  let tiles = doc.createElement("box");
  tiles.classList.add("devtools-tooltip-tiles");
  if (parentEl) {
    parentEl.appendChild(tiles);
  }
  return tiles;
}

/**
 * Internal util, checks whether a css declaration is a gradient
 */
function isGradientRule(property, value) {
  return (property === "background" || property === "background-image") &&
    value.match(GRADIENT_RE);
}

/**
 * Internal util, checks whether a css declaration is a color
 */
function isColorOnly(property, value) {
  return property === "background-color" ||
         property === "color" ||
         property.match(BORDERCOLOR_RE);
}

/**
 * Internal util, returns the background image uri if any
 */
function getBackgroundImageUri(value, sheetHref) {
  let uriMatch = BACKGROUND_IMAGE_RE.exec(value);
  let uri = null;

  if (uriMatch && uriMatch[1]) {
    uri = uriMatch[1];
    if (sheetHref) {
      let sheetUri = IOService.newURI(sheetHref, null, null);
      uri = sheetUri.resolve(uri);
    }
  }

  return uri;
}

/**
 * L10N utility class
 */
function L10N() {}
L10N.prototype = {};

let l10n = new L10N();

loader.lazyGetter(L10N.prototype, "strings", () => {
  return Services.strings.createBundle(
    "chrome://browser/locale/devtools/inspector.properties");
});
