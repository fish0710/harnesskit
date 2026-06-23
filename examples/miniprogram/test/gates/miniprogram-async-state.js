import {
  connectMiniProgram,
  relaunchAndWait,
  tapElement,
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
  await tapElement(page, ".load-button");
  await waitForText(page, ".async-result", "loaded from mock");
  console.log("async state passed");
} finally {
  await miniProgram.restoreWxMethod("request");
  await miniProgram.close();
}
