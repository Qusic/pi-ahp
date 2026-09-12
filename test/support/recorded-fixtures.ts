import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RECORDED_SCENARIOS, type RecordedScenario } from "./recorded-scenarios.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface RecordedFixture {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly turns: readonly (readonly unknown[])[];
	/** Distinct `partial` payloads the turns refer to by index. */
	readonly partials?: readonly unknown[];
	readonly events: readonly AgentSessionEvent[];
}

export interface RecordedFixtureCase {
	readonly scenario: RecordedScenario;
	readonly fixture: RecordedFixture;
}

function parseFixture(scenario: RecordedScenario): RecordedFixture {
	const path = join(FIXTURE_DIR, `${scenario.name}.json`);
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RecordedFixture>;
	if (value.name !== scenario.name) {
		throw new Error(`${path}: fixture name ${JSON.stringify(value.name)} does not match ${scenario.name}`);
	}
	if (value.description !== scenario.description) {
		throw new Error(`${path}: description differs from the recorded scenario manifest`);
	}
	if (value.prompt !== scenario.prompt) {
		throw new Error(`${path}: prompt differs from the recorded scenario manifest`);
	}
	if (!Array.isArray(value.turns) || !Array.isArray(value.events)) {
		throw new Error(`${path}: fixture must contain provider turns and pi events`);
	}
	return value as RecordedFixture;
}

/** Loads the complete corpus, rejecting missing, extra, renamed, or stale fixtures. */
export function loadRecordedFixtures(): RecordedFixtureCase[] {
	const names = RECORDED_SCENARIOS.map((scenario) => scenario.name);
	if (new Set(names).size !== names.length) {
		throw new Error("recorded scenario names must be unique");
	}

	const expectedFiles = names.map((name) => `${name}.json`).sort();
	const actualFiles = readdirSync(FIXTURE_DIR)
		.filter((name) => name.endsWith(".json"))
		.sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(
			`recorded fixture set differs from the manifest; expected=${JSON.stringify(expectedFiles)}, actual=${JSON.stringify(actualFiles)}`,
		);
	}

	return RECORDED_SCENARIOS.map((scenario) => ({ scenario, fixture: parseFixture(scenario) }));
}
