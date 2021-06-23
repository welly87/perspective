/******************************************************************************
 *
 * Copyright (c) 2017, the Perspective Authors.
 *
 * This file is part of the Perspective library, distributed under the terms of
 * the Apache License 2.0.  The full license can be found in the LICENSE file.
 *
 */

const {bash, execute, getarg, docker, execute_throw} = require("./script_utils.js");
const minimatch = require("minimatch");
const fs = require("fs");
const path = require("path");

const PACKAGE = process.env.PACKAGE;
const DEBUG_FLAG = getarg("--debug") ? "" : "--silent";
const IS_INSIDE_PUPPETEER = !!getarg("--private-puppeteer");
const IS_WRITE = !!getarg("--write") || process.env.WRITE_TESTS;
console.log("path", path.join(process.cwd(), "node_modules", "puppeteer"));
const IS_LOCAL_PUPPETEER = fs.existsSync(path.join(process.cwd(), "node_modules", "puppeteer"));

// Unfortunately we have to handle parts of the Jupyter test case here,
// as the Jupyter server needs to be run outside of the main Jest process.
const IS_JUPYTER = getarg("--jupyter") && minimatch("perspective-jupyterlab", PACKAGE);

console.log("IS_LOCAL", IS_LOCAL_PUPPETEER, "IS_JLAB", IS_JUPYTER);

if (IS_WRITE) {
    console.log("-- Running the test suite in Write mode");
}

if (getarg("--saturate")) {
    console.log("-- Running the test suite in saturate mode");
}

if (getarg("--debug")) {
    console.log("-- Running tests in debug mode - all console.log statements are preserved.");
}

function silent(x) {
    return bash`output=$(${x}); ret=$?; echo "\${output}"; exit $ret`;
}

/**
 * Run tests for all packages in parallel.
 */
function jest_all() {
    return bash`
        PSP_SATURATE=${!!getarg("--saturate")} 
        PSP_PAUSE_ON_FAILURE=${!!getarg("--interactive")}
        WRITE_TESTS=${IS_WRITE} 
        TZ=UTC 
        node_modules/.bin/jest 
        --rootDir=.
        --config=packages/perspective-test/jest.all.config.js 
        --color
        --verbose 
        --maxWorkers=50%
        --testPathIgnorePatterns='timezone'
        ${getarg("--bail") && "--bail"}
        ${getarg("--debug") || "--silent 2>&1 --noStackTrace"} 
        --testNamePattern="${get_regex()}"`;
}

/**
 * Run tests for a single package.
 */
function jest_single(cmd) {
    console.log(`-- Running "${PACKAGE}" test suite`);
    return bash`
        PSP_SATURATE=${!!getarg("--saturate")}
        PSP_PAUSE_ON_FAILURE=${!!getarg("--interactive")}
        WRITE_TESTS=${IS_WRITE}
        IS_LOCAL_PUPPETEER=${IS_LOCAL_PUPPETEER}
        TZ=UTC 
        node_modules/.bin/lerna exec 
        --concurrency 1 
        --no-bail
        --scope="@finos/${PACKAGE}" 
        -- 
        yarn ${cmd ? cmd : "test:run"}
        ${DEBUG_FLAG}
        ${getarg("--interactive") && "--runInBand"}
        --testNamePattern="${get_regex()}"`;
}

/**
 * Run timezone tests in a new Node process.
 */
function jest_timezone() {
    console.log("-- Running Perspective.js timezone test suite");
    return bash`
        node_modules/.bin/lerna exec 
        --concurrency 1 
        --no-bail
        --scope="@finos/perspective" 
        -- 
        yarn test_timezone:run
        ${DEBUG_FLAG}
        --testNamePattern="${get_regex()}"`;
}

function get_regex() {
    const regex = getarg`-t`;
    if (regex) {
        console.log(`-- Qualifying search '${regex}'`);
        return regex.replace(/ /g, ".");
    }
}

try {
    if (!IS_INSIDE_PUPPETEER && !IS_LOCAL_PUPPETEER) {
        if (IS_JUPYTER) {
            throw new Error("Error: Jupyterlab tests must be run against local puppeteer!");
        }

        execute`node_modules/.bin/lerna exec -- mkdir -p dist/umd`;
        execute`node_modules/.bin/lerna run test:build --stream --scope="@finos/${PACKAGE}"`;
        execute`yarn --silent clean --screenshots`;

        if (!PACKAGE || minimatch("perspective-vieux", PACKAGE)) {
            console.log("-- Running Rust tests");
            execute`yarn lerna --scope=@finos/perspective-vieux exec yarn test`;
        }

        execute`${docker("puppeteer")} node scripts/test_js.js --private-puppeteer ${getarg()}`;
    } else {
        if (!IS_INSIDE_PUPPETEER && (!PACKAGE || minimatch("perspective-vieux", PACKAGE))) {
            console.log("-- Running Rust tests");
            execute`yarn lerna --scope=@finos/perspective-vieux exec yarn test`;
        }

        if (IS_LOCAL_PUPPETEER) {
            execute`yarn --silent clean --screenshots`;
            execute`node_modules/.bin/lerna exec -- mkdir -p dist/umd`;

            if (IS_JUPYTER) {
                // Start the Jupyterlab server
                execute`node_modules/.bin/lerna run test:jupyter:jlab_start --stream --scope="@finos/${PACKAGE}"`;
            } else {
                execute`node_modules/.bin/lerna run test:build --stream --scope="@finos/${PACKAGE}"`;
            }
        }

        if (getarg("--quiet")) {
            // Run all tests with suppressed output.
            console.log("-- Running jest in quiet mode");
            execute(silent(jest_timezone()));
            execute(silent(jest_all()));
        } else if (process.env.PACKAGE) {
            // Run tests for a single package.
            if (IS_JUPYTER) {
                // Jupyterlab is guaranteed to have started at this point, so
                // copy the test files over and run the tests.
                execute`node_modules/.bin/lerna run test:jupyter:build --stream --scope="@finos/${PACKAGE}"`;
                execute_throw(jest_single("test:jupyter:run"));
                return;
            }

            if (minimatch("perspective", PACKAGE)) {
                execute(jest_timezone());
            }

            execute(jest_single());
        } else {
            // Run all tests with full output.
            console.log("-- Running jest in fast mode");
            execute(jest_timezone());
            execute(jest_all());
        }
    }
} catch (e) {
    console.log(e.message);

    // If we are running Jupyterlab tests, need to clean up the process if
    // the tests error for any reason.
    if (IS_JUPYTER && IS_LOCAL_PUPPETEER) {
        console.log("-- Cleaning up Jupyterlab process after test error...");
        execute`pkill -f "jupyter-lab --no-browser"`;
    }

    process.exit(1);
}
