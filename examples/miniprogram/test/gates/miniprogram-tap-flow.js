import {
  connectMiniProgram,
  relaunchAndWait,
  tapElement,
  waitForText,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/index/index", ".page-ready");
  await tapElement(page, ".primary-action");
  await waitForText(page, ".status-text", "已点击");
  console.log("tap flow passed");
} finally {
  await miniProgram.close();
}
