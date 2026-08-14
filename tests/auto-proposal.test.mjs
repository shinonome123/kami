import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_PROPOSE_GROWTH_WINDOW, AUTO_PROPOSE_THRESHOLD, createAutoProposer, evaluateAutoProposeDecision } from "../src/auto-proposal.mjs";

test("阈值默认 10，窗口默认 10", () => {
  assert.equal(AUTO_PROPOSE_THRESHOLD, 10);
  assert.equal(AUTO_PROPOSE_GROWTH_WINDOW, 10);
});

test("人工终稿未达阈值时不提议", () => {
  const decision = evaluateAutoProposeDecision({ acceptedCount: 9, activeCandidateCount: 0 });
  assert.equal(decision.propose, false);
  assert.match(decision.reason, /未达自动提议阈值/);
});

test("达到阈值且无候选时提议", () => {
  const decision = evaluateAutoProposeDecision({ acceptedCount: 10, activeCandidateCount: 0 });
  assert.equal(decision.propose, true);
});

test("已有活跃候选时即使数据充足也不重复提议", () => {
  const decision = evaluateAutoProposeDecision({ acceptedCount: 30, activeCandidateCount: 1 });
  assert.equal(decision.propose, false);
  assert.match(decision.reason, /已有待评测候选/);
});

test("上次成功提议后需满足增长窗口，否则防抖", () => {
  const champion = { metadata: { autoPropose: { lastAcceptedCount: 10, lastError: "" } } };
  const within = evaluateAutoProposeDecision({ champion, acceptedCount: 12, activeCandidateCount: 0 });
  assert.equal(within.propose, false);
  assert.match(within.reason, /未达增长窗口/);
  const reached = evaluateAutoProposeDecision({ champion, acceptedCount: 20, activeCandidateCount: 0 });
  assert.equal(reached.propose, true);
});

test("上次失败后只要新增人工终稿就允许重试", () => {
  const champion = { metadata: { autoPropose: { lastAcceptedCount: 10, lastError: "模型不可用" } } };
  const decision = evaluateAutoProposeDecision({ champion, acceptedCount: 11, activeCandidateCount: 0 });
  assert.equal(decision.propose, true);
  assert.match(decision.reason, /重试/);
});

test("工厂串行执行并去重：并发检查只产生一次提议", async () => {
  const calls = [];
  let activeCandidates = 0;
  const deps = {
    getCurrentChampion: async () => ({ id: "champion-1", metadata: {} }),
    countAcceptedTrajectories: async () => 12,
    listActiveCandidates: async () => activeCandidates ? [{ id: "candidate-1" }] : [],
    listTrajectories: async () => [{ id: "t1", status: "completed", finalTranslation: "x" }],
    selectTrajectories: (trajectories) => trajectories.slice(0, 40),
    propose: async ({ trajectories }) => {
      calls.push(trajectories.length);
      activeCandidates = 1;
      return { id: "candidate-1" };
    },
    recordMetadata: async () => {}
  };
  const proposer = createAutoProposer({ deps, threshold: 10, growthWindow: 10 });
  const [first, second] = await Promise.all([proposer.maybePropose({}), proposer.maybePropose({})]);
  assert.equal(calls.length, 1, "两次并发检查只应提议一次");
  assert.equal(first.proposed, true);
  assert.equal(second.proposed, false);
  assert.match(second.reason, /已有待评测候选/);
});

test("提议失败时记录 lastError 并返回 proposed=false", async () => {
  let recorded = null;
  const deps = {
    getCurrentChampion: async () => ({ id: "champion-1", metadata: { autoPropose: { lastAcceptedCount: 10, lastError: "上次失败" } } }),
    countAcceptedTrajectories: async () => 11,
    listActiveCandidates: async () => [],
    listTrajectories: async () => [{ id: "t1", status: "completed", finalTranslation: "x" }],
    selectTrajectories: (trajectories) => trajectories,
    propose: async () => { throw new Error("模型服务不可用"); },
    recordMetadata: async (championId, metadata, autoPropose) => { recorded = autoPropose; }
  };
  const proposer = createAutoProposer({ deps, threshold: 10, growthWindow: 10 });
  const result = await proposer.maybePropose({});
  assert.equal(result.proposed, false);
  assert.equal(recorded.lastError, "模型服务不可用");
  assert.equal(recorded.lastAcceptedCount, 10, "失败时保留上次成功计数，等待重试");
});

test("maybePropose 永不拒绝：deps 抛错时返回原因而不是抛出", async () => {
  const deps = {
    getCurrentChampion: async () => { throw new Error("存储不可用"); },
    countAcceptedTrajectories: async () => 0,
    listActiveCandidates: async () => [],
    listTrajectories: async () => [],
    selectTrajectories: (trajectories) => trajectories,
    propose: async () => ({}),
    recordMetadata: async () => {}
  };
  const proposer = createAutoProposer({ deps });
  const result = await proposer.maybePropose({});
  assert.equal(result.proposed, false);
  assert.equal(result.reason, "存储不可用");
});
