'use strict';
const nodeUtil = require('util');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const electron = require('electron');
const util = require('electron-util');
const getPort = require('get-port');
const logger = require('electron-timber');
const makeDir = require('make-dir');
const {supportedCurrencies} = require('./supported-currencies');

// `electron-builder` uses different names
const platformMapping = new Map([
	['darwin', 'mac'],
	['linux', 'linux'],
	['win32', 'win'],
]);

let binPath = path.join(__dirname, 'bin', platformMapping.get(process.platform), `marketmaker${util.is.windows ? '.exe' : ''}`);
binPath = util.fixPathForAsarUnpack(binPath);

const execFile = nodeUtil.promisify(childProcess.execFile);

const mmLogger = logger.create({
	name: 'mm',
	ignore: /cant open\.\(|connected to push\.\(/,
});

class Marketmaker {
	_isReady() {
		return new Promise((resolve, reject) => {
			const interval = setInterval(() => {
				const request = electron.net.request(`http://127.0.0.1:${this.port}`);

				request.on('response', response => {
					if (response.statusCode === 200) {
						clearInterval(interval);

						// Give it a little more time to avoid issues
						setTimeout(resolve, 500);
					}
				});
				request.on('error', () => {});
				request.end();
			}, 100);

			setTimeout(() => {
				clearInterval(interval);
				reject(new Error('Giving up trying to connect to marketmaker'));
			}, 10000);
		});
	}

	async _killProcess() {
		try {
			if (process.platform === 'win32') {
				await execFile('taskkill', ['/f', '/im', 'marketmaker.exe']);
			} else {
				await execFile('killall', ['-9', 'marketmaker']);
			}
		} catch (_) {}
	}

	async start(options) {
		this.isKillingPreviousMarketmaker = true;
		await this._killProcess();
		this.isKillingPreviousMarketmaker = false;

		options = Object.assign({}, options, {
			client: 1,
			gui: 'hyperdex',
			userhome: os.homedir(),
			rpcport: await getPort(),
			coins: supportedCurrencies,
		});

		this.port = options.rpcport;

		if (options.seedPhrase) {
			options.passphrase = options.seedPhrase;
			delete options.seedPhrase;
		} else {
			throw new Error('The `seedPhrase` option is required');
		}

		// Marketmaker writes a lot of files directly to CWD, so we make CWD the data directory
		const cwd = await makeDir(path.join(electron.app.getPath('userData'), 'marketmaker'));

		this.cp = childProcess.spawn(binPath, [JSON.stringify(options)], {cwd});

		this.cp.on('error', error => {
			this.isRunning = false;
			throw error;
		});

		this.cp.on('exit', () => {
			if (this.isKillingPreviousMarketmaker || !this.isRunning) {
				return;
			}

			this.isRunning = false;
			electron.dialog.showErrorBox('Marketmaker Crashed', 'HyperDEX will now relaunch.');
			electron.app.relaunch();
			electron.app.quit();
		});

		this.isRunning = true;
		logger.log('Marketmaker running on port', this.port);

		mmLogger.streamLog(this.cp.stdout);
		mmLogger.streamError(this.cp.stderr);

		electron.app.on('quit', async () => {
			await this.stop();
		});

		// `marketmaker` takes ~500ms to get ready to accepts requests
		await this._isReady();
	}

	async stop() {
		this.isRunning = false;

		// It's sometimes undefined when we do Cmd+R during development.
		// Just safeguarding it here to reduce the terminal noise.
		if (this.cp) {
			this.cp.kill();
		}

		this.cp = null;
		await this._killProcess();
	}
}

module.exports = new Marketmaker();
