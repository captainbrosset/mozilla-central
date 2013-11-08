/* vim: set ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Tests that the spectrum color picker works correctly

const TEST_URI = "data:text/html;charset=utf-8,<div></div>";
const {CSSTransformPreviewer} = devtools.require("devtools/shared/widgets/CSSTransformPreviewer");

let doc, root;

function test() {
  waitForExplicitFinish();
  addTab(TEST_URI, () => {
    doc = content.document;
    root = doc.querySelector("div");
    startTests();
  });
}

function endTests() {
  doc = root = null;
  gBrowser.removeCurrentTab();
  finish();
}

function startTests() {
  testCreateAndDestroyShouldAppendAndRemoveElements();
}

function testCreateAndDestroyShouldAppendAndRemoveElements() {
  ok(root, "We have the root node to append the preview to");
  is(root.childElementCount, 0, "Root node is empty");

  let p = new CSSTransformPreviewer(root);
  p.preview("matrix(1, -0.2, 0, 1, 0, 0)");
  ok(root.childElementCount > 0, "Preview has appended elements");
  ok(root.querySelector("canvas"), "Canvas preview element is here");

  p.destroy();
  is(root.childElementCount, 0, "Destroying preview removed all nodes");

  testCanvasDimensionIsConstrainedByMaxDim();
}

function testCanvasDimensionIsConstrainedByMaxDim() {
  let p = new CSSTransformPreviewer(root);
  p.MAX_DIM = 500;
  p.preview("scale(1)", "center", 1000, 1000);

  let canvas = root.querySelector("canvas");
  is(canvas.width, 500, "Canvas width is correct");
  is(canvas.height, 500, "Canvas height is correct");

  p.destroy();

  testCallingPreviewSeveralTimesReusesTheSameCanvas();
}

function testCallingPreviewSeveralTimesReusesTheSameCanvas() {
  let p = new CSSTransformPreviewer(root);

  p.preview("scale(1)", "center", 1000, 1000);
  let canvas = root.querySelector("canvas");

  p.preview("rotate(90deg)");
  let canvases = root.querySelectorAll("canvas");
  is(canvases.length, 1, "Still one canvas element");
  is(canvases[0], canvas, "Still the same canvas element");
  p.destroy();

  testCanvasDimensionCorrectInSomeCases();
}

function testCanvasDimensionCorrectInSomeCases() {
  let p = new CSSTransformPreviewer(root);
  p.MAX_DIM = 200;

  // Translate a square by its width
  p.preview("translateX(200px)", "center", 200, 200);
  let canvas = root.querySelector("canvas");
  is(canvas.width, 200, "width is correct");
  is(canvas.height, 100, "height is half of the width");

  // Rotate on the top right corner
  p.preview("rotate(-90deg)", "top right", 200, 200);
  is(canvas.width, 200, "width is correct");
  is(canvas.height, 100, "height is half of the width");

  p.destroy();

  testPreviewingInvalidTransformReturnsFalse();
}

function testPreviewingInvalidTransformReturnsFalse() {
  let p = new CSSTransformPreviewer(root);
  ok(!p.preview("veryWow(muchPx) suchTransform(soDeg)"), "Returned false for invalid transform");
  ok(!p.preview("rotae(3deg)"), "Returned false for invalid transform");

  // Verify the canvas is empty by checking the image data
  let canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
  let data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0, n = data.length; i < n; i += 4) {
    // Let's not log 250*250*4 asserts! Instead, just log when it fails
    let red = data[i];
    let green = data[i + 1];
    let blue = data[i + 2];
    let alpha = data[i + 3];
    if (red !== 0 || green !== 0 || blue !== 0 || alpha !== 0) {
      ok(false, "Image data is not empty after an invalid transformed was previewed");
      break;
    }
  }

  is(p.preview("translateX(30px)"), true, "Returned true for a valid transform");
  endTests();
}
