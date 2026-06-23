import {
  connectMiniProgram,
  expectCurrentRoute,
  expectText,
  relaunchAndWait,
  tapElement,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/index/index", ".page-ready");
  await tapElement(page, ".details-link");

  const detailPage = await expectCurrentRoute(miniProgram, "pages/details/index");
  await expectText(detailPage, ".page-title", "详情");
  console.log("navigation passed");
} finally {
  await miniProgram.close();
}
