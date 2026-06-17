import {
  connectMiniProgram,
  expectElement,
  relaunchAndWait,
  waitForText,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/index/index", ".page-ready");
  const action = await expectElement(page, ".primary-action");
  await action.tap();
  await waitForText(page, ".status-text", "已点击");
  console.log("tap flow passed");
} finally {
  await miniProgram.close();
}
