const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const port = 3000;

const ensureDir = (dir) => {
	try {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	} catch (error) {
		console.error(`Error creating directory ${dir}:`, error.message);
		logError(`Error creating directory ${dir}: ${error.message}`);
	}
};

// Ensure necessary directories exist
const dirs = ['public', 'uploads', 'screenshots', 'logs'].map(dir => path.join(__dirname, dir));
dirs.forEach(dir => ensureDir(dir));

const logError = (message) => {
	const errorLogPath = path.join(__dirname, 'logs', 'error.log');
	fs.appendFileSync(errorLogPath, `${new Date().toISOString()} - ${message}\n`);
};

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));
app.use('/logs', express.static(path.join(__dirname, 'logs')));

const upload = multer({ dest: 'uploads/' });

const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

let isCapturing = false;
const numBrowsers = 5;
const browsers = [];

// Launch 5 browsers when the server starts
async function launchBrowsers() {
	console.log('Launching 5 browsers...');
	for (let i = 0; i < numBrowsers; i++) {
		const browser = await puppeteer.launch({
			headless: 'new',
			args: ['--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-features=IsolateOrigins,site-per-process',
				'--disable-blink-features=AutomationControlled',
				'--start-fullscreen']
		});
		browsers.push(browser);
	}
}

// Close browsers when the process exits
async function closeBrowsers() {
	console.log('Closing browsers...');
	await Promise.all(browsers.map(browser => browser.close().catch(err => logError(`Error closing browser: ${err.message}`))));
}

// Launch browsers when the server starts
launchBrowsers().catch(err => console.error('Error launching browsers:', err.message));

async function autoScroll(page, distance, delay) {
	await page.evaluate(async (distance, delay) => {
		await new Promise((resolve) => {
			let totalHeight = 0;
			const timer = setInterval(() => {
				window.scrollBy(0, distance);
				totalHeight += distance;

				if (totalHeight >= document.body.scrollHeight) {
					clearInterval(timer);
					resolve();
				}
			}, delay);
		});
	}, distance, delay);
}

async function waitForAnimationsToFinish(page) {
	await page.waitForFunction(() => {
		// Check if there are no ongoing animations or transitions
		const animations = document.querySelectorAll('*');
		for (let element of animations) {
			const style = window.getComputedStyle(element);

			// If the element has any ongoing animation or transition
			if (style.animationPlayState !== 'paused' || style.transitionDuration !== '0s') {
				return false;  // If any animation is running, return false
			}
		}
		return true; // No animations are running
	}, { timeout: 10000 });  // 60 seconds timeout
}

async function disableAnimations(page) {
	await page.evaluate(() => {
		// Disable all CSS animations and transitions on the page
		const style = document.createElement('style');
		style.innerHTML = `
        * {
          animation: none !important;
          transition: none !important;
        }
      `;
		document.head.appendChild(style);
	});
}

async function convertPngToJpeg(pngBuffer, outputPath) {
	try {
		await sharp(pngBuffer)
			.resize({ height: 1600 }) // Resize to height 1600px, keeping aspect ratio
			.jpeg({
				quality: 85,         // Set JPEG quality to 85%
				progressive: true,   // Enable progressive loading
				optimizeScans: true, // Optimize scans for better compression
			})
			.toFile(outputPath);

		console.log(`JPEG image saved to ${outputPath}`);
	} catch (error) {
		console.error('Error converting PNG to JPEG:', error);
	}
}

async function captureStaticParts(page) {
	return page.screenshot({ type: 'png', fullPage: true });
}

async function captureScreenshot(url, browser, width, screenshotDir, logFile) {
	let page;
	try {
		console.log("start")
		isCapturing = true;
		page = await browser.newPage();
		await page.setViewport({ width: width, height: 1080 });

		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			url = `https://${url}`;
		}
		console.log(`Capturing: ${url}`);
		
		await page.goto(url, { waitUntil: 'networkidle2' }); // Faster than 'networkidle2'

		const staticBuffer = await page.screenshot({ type: 'png', fullPage: 'true' });
		const safeUrl = url.trim().replace(/[:/\\?%*|"<>]/g, '_');
		const _outputPath = path.join(screenshotDir, `${safeUrl}1.jpg`);
		await convertPngToJpeg(staticBuffer, _outputPath)
		// **Smooth Scroll Down to Load All Content**
		let previousHeight = 0;
		for (let i = 0; i < 5; i++) { // Max 3 scrolls
			previousHeight = await page.evaluate(() => document.body.scrollHeight);
			await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700))); // Faster delay
			let newHeight = await page.evaluate(() => document.body.scrollHeight);
			if (newHeight === previousHeight) break; // Stop if no new content loads
		}

		// **Force Scroll to Footer Manually**
		// await page.evaluate(() => {
		// 	window.scrollTo(0, document.body.scrollHeight);
		// });
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700))); // Small wait to ensure visibility

		// **Capture Screenshot**
		// const safeUrl = url.trim().replace(/[:/\\?%*|"<>]/g, '_');
		const outputPath = path.join(screenshotDir, `${safeUrl}.jpg`);
		const pngBuffer = await page.screenshot({ type: 'png', fullPage: 'true' });
		await convertPngToJpeg(pngBuffer, outputPath);
		console.log(`Screenshot saved: ${outputPath}`);

		// **Log Screenshot Capture**
		fs.appendFileSync(logFile, `${new Date().toISOString()},${url},${outputPath}\n`);

	} catch (err) {
		console.error(`Error capturing screenshot for ${url}:`, err.message);
		logError(`Error capturing screenshot for ${url}: ${err.message}`);
	} finally {
		if (page) await page.close();
		isCapturing = false;
	}
}


async function captureScreenshotsInBatches(urls, width, concurrency) {
	if (browsers.length === 0) {
		console.error('No browsers available');
		return;
	}

	const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
	const screenshotDir = path.join(__dirname, 'screenshots', timestamp);
	ensureDir(screenshotDir);
	const logFile = path.join(__dirname, 'logs', `log-${timestamp}.csv`);
	fs.writeFileSync(logFile, 'Timestamp,URL,File Path\n');

	try {
		const tasks = [];
		for (let i = 0; i < urls.length; i++) {
			const browserIndex = i % numBrowsers;
			tasks.push(captureScreenshot(urls[i], browsers[browserIndex], width, screenshotDir, logFile));
			if (tasks.length >= concurrency) {
				await Promise.all(tasks);
				tasks.length = 0;
			}
		}
		await Promise.all(tasks);
	} catch (error) {
		console.error('Error processing batch:', error.message);
		logError(`Error processing batch: ${error.message}`);
	}
}

app.get('/api/status', (req, res) => {
	res.json({ isCapturing });
});

app.post('/screenshot', upload.single('urlFile'), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).send('No file uploaded. Please upload a valid file.');
		}

		const width = parseInt(req.body.width, 10) || 1800;
		const concurrency = parseInt(req.body.concurrency, 10) || 5;
		const urls = fs.readFileSync(req.file.path, 'utf-8').split('\n').filter(Boolean);

		if (urls.length === 0) {
			return res.status(400).send('Uploaded file is empty or contains no valid URLs.');
		}

		await captureScreenshotsInBatches(urls, width, concurrency);
		res.send('Screenshots captured successfully! <a href="/">Go back</a>');
	} catch (error) {
		console.error('Error handling /screenshot request:', error.message);
		logError(`Error handling /screenshot request: ${error.message}`);
		res.status(500).send('An error occurred while capturing screenshots.');
	}
});

app.get('/api/img-folders', (req, res) => {
	const screenshotDir = path.join(__dirname, 'screenshots');
	const folders = fs.readdirSync(screenshotDir)
		.filter(file => fs.statSync(path.join(screenshotDir, file)).isDirectory())
		.map(folder => ({
			name: folder,
			screenshots: fs.readdirSync(path.join(screenshotDir, folder))
				.filter(file => file.endsWith('.png'))
				.map(file => ({
					id: file.split('.')[0],
					name: file,
					src: `/screenshots/${folder}/${file}`
				}))
		}));
	res.json(folders);
});

app.get('/api/log-folders', (req, res) => {
	const logDir = path.join(__dirname, 'logs');
	const logs = fs.readdirSync(logDir)
		.filter(file => file.endsWith('.csv'))
		.map((file, index) => ({
			id: index + 1,
			name: file,
			src: path.join('/logs', file)
		}));
	res.json({ logs });
});

app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
	console.log(`Server running at http://localhost:${port}`);
});

// Close browsers when the process exits
process.on('SIGINT', async () => {
	await closeBrowsers();
	process.exit(0);
});




// await page.evaluate(() => {
//     return new Promise((resolve) => {
//         const doc = document;
//         const computedStyle = window.getComputedStyle(doc.body);
//         const animationDuration = parseFloat(computedStyle.animationDuration) || 0;
//         const transitionDuration = parseFloat(computedStyle.transitionDuration) || 0;
//         const maxDuration = Math.max(animationDuration, transitionDuration);

//         if (maxDuration === 0) {
//             resolve();
//             return;
//         }

//         let animationCount = 0;
//         const handleAnimationStart = () => animationCount++;
//         const handleAnimationEnd = () => {
//             animationCount--;
//             if (animationCount === 0) {
//                 doc.removeEventListener('animationstart', handleAnimationStart);
//                 doc.removeEventListener('animationend', handleAnimationEnd);
//                 doc.removeEventListener('transitionstart', handleAnimationStart);
//                 doc.removeEventListener('transitionend', handleAnimationEnd);
//                 resolve();
//             }
//         };

//         doc.addEventListener('animationstart', handleAnimationStart);
//         doc.addEventListener('animationend', handleAnimationEnd);
//         doc.addEventListener('transitionstart', handleAnimationStart);
//         doc.addEventListener('transitionend', handleAnimationEnd);
//     });
// });
// await autoScroll(page, innnerHeight, 200); // Scrolls 100 pixels every 200 milliseconds


// await page.evaluate(() => {
//     const style = document.createElement('style');
//     style.innerHTML = `
//         * {
//             animation: none !important;
//             transition: none !important;
//         }
//     `;
//     document.head.appendChild(style);
// });
