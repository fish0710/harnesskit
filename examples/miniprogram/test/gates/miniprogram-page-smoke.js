import {
  connectMiniProgram,
  expectText,
  relaunchAndWait,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/index/index", ".page-ready");
  await expectText(page, ".page-title", "首页");
  console.log("page smoke passed");
} finally {
  await miniProgram.close();
}
