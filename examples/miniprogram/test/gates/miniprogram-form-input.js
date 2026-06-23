import {
  connectMiniProgram,
  inputText,
  relaunchAndWait,
  triggerElement,
  waitForText,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/profile/edit", ".profile-form");
  await inputText(page, ".name-input", "Alice");
  await triggerElement(page, ".submit-button", "click");

  await waitForText(page, ".form-result", "Hello Alice");
  console.log("form input passed");
} finally {
  await miniProgram.close();
}
