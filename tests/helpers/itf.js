// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Decodes a value of the Informal Trace Format
// (https://apalache-mc.org/docs/adr/015adr-trace.html) that `quint run
// --out-itf` writes: integers become numbers, sets `Set`s, maps `Map`s,
// tuples arrays; records and lists keep their JSON shape.
export function decodeItf(value) {
  if (Array.isArray(value)) {
    return value.map(decodeItf);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if ("#bigint" in value) {
    return Number(value["#bigint"]);
  }
  if ("#set" in value) {
    return new Set(value["#set"].map(decodeItf));
  }
  if ("#map" in value) {
    return new Map(value["#map"].map(([k, v]) => [decodeItf(k), decodeItf(v)]));
  }
  if ("#tup" in value) {
    return value["#tup"].map(decodeItf);
  }
  if ("#unserializable" in value) {
    throw new Error(`unserializable ITF value: ${value["#unserializable"]}`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, decodeItf(v)]),
  );
}

// The steps of an ITF trace written with `--mbt`: the state each step
// leaves, the action that produced it and the values its `nondet`
// bindings picked (only the ones the action bound).
export function decodeTrace(trace) {
  return trace.states.map((state) => {
    const picks = {};
    for (const [name, option] of Object.entries(
      decodeItf(state["mbt::nondetPicks"] ?? {}),
    )) {
      if (option.tag === "Some") {
        picks[name] = option.value;
      }
    }
    return {
      action: state["mbt::actionTaken"],
      picks,
      s: decodeItf(state.s),
    };
  });
}
