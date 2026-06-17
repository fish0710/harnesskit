import {
  connectMiniProgram,
  expectElement,
  relaunchAndWait,
  waitForText,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  await miniProgram.mockWxMethod("request", function mockRequest(options) {
    options.success({
      statusCode: 200,
      data: { message: "loaded from mock" },
    });
  });

  const page = await relaunchAndWait(miniProgram, "/pages/index/index", ".page-ready");
  const loadButton = await expectElement(page, ".load-button");
  await loadButton.tap();
  await waitForText(page, ".async-result", "loaded from mock");
  console.log("async state passed");
} finally {
  await miniProgram.restoreWxMethod("request");
  await miniProgram.close();
}
