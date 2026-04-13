const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

function logStep(title) {
  console.log(`\n=== ${title} ===`);
}

function logResult(label, result) {
  console.log(`- ${label}: ${result}`);
}

async function createUser(attrs = {}) {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");

  const suffix = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({
    username: attrs.username || `user_${suffix}`,
    email: attrs.email || `${suffix}@test.local`,
    role: attrs.role || "user",
    passwordHash: "hashed",
    displayName: attrs.displayName || "",
    bio: attrs.bio || "",
  });

  return { user, token: signToken(user) };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  let mongod;

  try {
    mongod = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongod.getUri();
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

    const { connectDB } = require("../src/config/db");
    await connectDB();

    const app = require("../src/app");
    const Idea = require("../src/models/Idea");
    const Comment = require("../src/models/Comment");

    logStep("环境准备");
    const alice = await createUser({ username: "blocking_alice", email: "blocking_alice@test.local" });
    const bob = await createUser({ username: "blocking_bob", email: "blocking_bob@test.local" });
    const carol = await createUser({ username: "blocking_carol", email: "blocking_carol@test.local" });
    logResult("测试账号", `alice=${alice.user._id} bob=${bob.user._id} carol=${carol.user._id}`);

    const bobIdea = await Idea.create({
      title: "Bob idea for blocking flow",
      summary: "",
      content: "",
      author: bob.user._id,
      tags: ["block-flow"],
      visibility: "public",
    });
    const aliceIdea = await Idea.create({
      title: "Alice idea for blocking flow",
      summary: "",
      content: "",
      author: alice.user._id,
      tags: ["block-flow"],
      visibility: "public",
    });
    const carolIdea = await Idea.create({
      title: "Carol control idea",
      summary: "",
      content: "",
      author: carol.user._id,
      tags: ["control"],
      visibility: "public",
    });
    logResult("公开 idea", `aliceIdea=${aliceIdea._id} bobIdea=${bobIdea._id} carolIdea=${carolIdea._id}`);

    const bobRootComment = await Comment.create({
      idea: bobIdea._id,
      author: bob.user._id,
      content: "Bob root comment",
    });
    await Comment.create({
      idea: aliceIdea._id,
      author: alice.user._id,
      content: "Alice root comment",
    });
    logResult("初始评论", `bobRoot=${bobRootComment._id}`);

    logStep("场景一：先攻击后拉黑应失败");
    await Comment.create({
      idea: bobIdea._id,
      author: alice.user._id,
      content: "Alice replies to Bob first",
      parentCommentId: bobRootComment._id,
    });

    const blockDenied = await request(app)
      .post(`/api/messages/blacklist/${bob.user._id}`)
      .set(authHeader(alice.token));

    logResult("POST /api/messages/blacklist/:userId", `${blockDenied.status} ${blockDenied.body.code || ""}`.trim());
    logResult("失败消息", blockDenied.body.message || "<empty>");

    logStep("场景二：被回帖后允许拉黑");
    const aliceRootComment = await Comment.create({
      idea: aliceIdea._id,
      author: alice.user._id,
      content: "Alice root for reply-back",
    });
    await Comment.create({
      idea: aliceIdea._id,
      author: bob.user._id,
      content: "Bob replies back to Alice",
      parentCommentId: aliceRootComment._id,
    });

    const blockAllowed = await request(app)
      .post(`/api/messages/blacklist/${bob.user._id}`)
      .set(authHeader(alice.token));

    logResult("POST /api/messages/blacklist/:userId", `${blockAllowed.status} ${blockAllowed.body.ok === true ? "ok=true" : "ok=false"}`);

    logStep("场景三：双向资料与评论隐藏");
    const bobViewAliceProfile = await request(app)
      .get(`/api/users/${alice.user._id}`)
      .set(authHeader(bob.token));
    const aliceViewBobProfile = await request(app)
      .get(`/api/users/${bob.user._id}`)
      .set(authHeader(alice.token));
    const bobViewAliceComments = await request(app)
      .get(`/api/ideas/${aliceIdea._id}/comments`)
      .set(authHeader(bob.token));
    const aliceViewBobComments = await request(app)
      .get(`/api/ideas/${bobIdea._id}/comments`)
      .set(authHeader(alice.token));
    const bobIdeaList = await request(app)
      .get("/api/ideas")
      .set(authHeader(bob.token));
    const aliceIdeaList = await request(app)
      .get("/api/ideas")
      .set(authHeader(alice.token));

    const bobVisibleIdeaIds = (bobIdeaList.body.ideas || []).map((item) => String(item._id));
    const aliceVisibleIdeaIds = (aliceIdeaList.body.ideas || []).map((item) => String(item._id));
    const bobCarolVisible = bobVisibleIdeaIds.includes(String(carolIdea._id));
    const aliceCarolVisible = aliceVisibleIdeaIds.includes(String(carolIdea._id));

    logResult("Bob 查看 Alice 资料", `${bobViewAliceProfile.status} ${(bobViewAliceProfile.body && bobViewAliceProfile.body.code) || ""}`.trim());
    logResult("Alice 查看 Bob 资料", `${aliceViewBobProfile.status} ${(aliceViewBobProfile.body && aliceViewBobProfile.body.code) || ""}`.trim());
    logResult("Bob 查看 Alice 评论", `${bobViewAliceComments.status} ${(bobViewAliceComments.body && bobViewAliceComments.body.code) || ""}`.trim());
    logResult("Alice 查看 Bob 评论", `${aliceViewBobComments.status} ${(aliceViewBobComments.body && aliceViewBobComments.body.code) || ""}`.trim());
    logResult("Bob ideas 列表含 Alice idea", bobVisibleIdeaIds.includes(String(aliceIdea._id)) ? "YES" : "NO");
    logResult("Alice ideas 列表含 Bob idea", aliceVisibleIdeaIds.includes(String(bobIdea._id)) ? "YES" : "NO");
    logResult("Bob 列表仍可见第三方 Carol 内容", bobCarolVisible ? "YES" : "NO");
    logResult("Alice 列表仍可见第三方 Carol 内容", aliceCarolVisible ? "YES" : "NO");

    logStep("结论");
    logResult("先攻击后拉黑失败", blockDenied.status === 403 ? "PASS" : "FAIL");
    logResult("被回帖后允许拉黑", blockAllowed.status === 200 && blockAllowed.body.ok === true ? "PASS" : "FAIL");
    logResult(
      "双向资料与评论隐藏",
      bobViewAliceProfile.status === 404 && aliceViewBobProfile.status === 404 && bobViewAliceComments.status === 404 && aliceViewBobComments.status === 404
        ? "PASS"
        : "FAIL"
    );
  } catch (error) {
    console.error("BLOCKING_INTEGRATION_FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
    if (mongod) {
      await mongod.stop().catch(() => {});
    }
  }
}

main();