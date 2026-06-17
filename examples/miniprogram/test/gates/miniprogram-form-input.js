import {
  connectMiniProgram,
  expectElement,
  relaunchAndWait,
  waitForText,
} from "./miniprogram-template-helpers.js";

const miniProgram = await connectMiniProgram();

try {
  const page = await relaunchAndWait(miniProgram, "/pages/profile/edit", ".profile-form");
  const nameInput = await expectElement(page, ".name-input");
  await nameInput.input("Alice");

  const submit = await expectElement(page, ".submit-button");
  await submit.tap();

  await waitForText(page, ".form-result", "Hello Alice");
  console.log("form input passed");
} finally {
  await miniProgram.close();
}
