import * as path from 'node:path'
import * as perf_hooks from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as child_process from 'node:child_process'

// Globals
const RUNFILES_ROOT = path.join(
    process.env.JS_BINARY__RUNFILES,
    process.env.JS_BINARY__WORKSPACE
)
const synced = new Map()
const mkdirs = new Set()

// Ensure that a directory exists. If it has not been previously created or does not exist then it
// creates the directory, first recursively ensuring that its parent directory exists. Intentionally
// synchronous to avoid race conditions between async promises. If we use `await fs.promises.mkdir(p)`
// then you could end up calling it twice in two different promises which
// would error on the 2nd call. This is because `if (!fs.existsSync(p))` followed by
// `await fs.promises.mkdir(p)` is not atomic so both promises can enter into the condition before
// either calls `mkdir`.
function mkdirpSync(p) {
    if (!p) {
        return
    }
    if (mkdirs.has(p)) {
        return
    }
    if (!fs.existsSync(p)) {
        mkdirpSync(path.dirname(p))
        fs.mkdirSync(p)
    }
    mkdirs.add(p)
}

async function walk(root, callback) {
    async function walkInternal(current) {
        const absolutePath = path.join(root, current)
        try {
            const lstat = await fs.promises.lstat(absolutePath)
            if (lstat.isSymbolicLink()) {
                await callback?.(current, lstat)
            } else if (lstat.isDirectory()) {
                await callback?.(current, lstat)
                const contents = await fs.promises.readdir(absolutePath)
                await Promise.all(
                    contents.map((entry) =>
                        walkInternal(path.join(current, entry))
                    )
                )
            } else {
                await callback?.(current, lstat)
            }
        } catch (e) {
            console.error(e)
            process.exit(1)
        }
    }
    await walkInternal('')
}

async function walkModifiedItems(root, callback) {
    let modified = 0
    await walk(root, async (entry, lstat) => {
        const currentPath = path.join(root, entry)
        const last = synced.get(currentPath)
        if (!lstat.isDirectory() && last && lstat.mtimeMs == last) {
            // this file is already up-to-date
            return
        }
        synced.set(currentPath, lstat.mtimeMs)
        await callback?.(entry, lstat)
        if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
            modified++
        }
    })
    return modified
}

// Recursively copies a file, symlink or directory to a destination. If the file has been previously
// synced it is only re-copied if the file's last modified time has changed since the last time that
// file was copied. Symlinks are not copied but instead a symlink is created under the destination
// pointing to the source symlink.
async function syncRecursive(src, dst, writePerm) {
    return walkModifiedItems(src, async (entry, lstat) => {
        const srcPath = path.join(src, entry)
        const dstPath = path.join(dst, entry)
        const exists = fs.existsSync(dstPath)
        if (lstat.isSymbolicLink()) {
            if (process.env.JS_BINARY__LOG_DEBUG) {
                console.error(
                    `Syncing symlink ${srcPath.slice(RUNFILES_ROOT.length + 1)}`
                )
            }
            if (exists) {
                await fs.promises.unlink(dstPath)
            } else {
                mkdirpSync(path.dirname(dstPath))
            }
            await fs.promises.symlink(srcPath, dstPath)
        } else if (lstat.isDirectory()) {
            if (!exists) {
                mkdirpSync(dstPath)
            }
        } else {
            if (process.env.JS_BINARY__LOG_DEBUG) {
                console.error(
                    `Syncing file ${srcPath.slice(RUNFILES_ROOT.length + 1)}`
                )
            }
            if (exists) {
                await fs.promises.unlink(dstPath)
            } else {
                mkdirpSync(path.dirname(dstPath))
            }
            await fs.promises.copyFile(srcPath, dstPath)
            if (writePerm) {
                const s = await fs.promises.stat(dstPath)
                const mode = s.mode | fs.constants.S_IWUSR
                console.error(
                    `Adding write permissions to file ${src.slice(
                        RUNFILES_ROOT.length + 1
                    )}: ${(mode & parseInt('777', 8)).toString(8)}`
                )
                await fs.promises.chmod(dstPath, mode)
            }
        }
    })
}

// Sync list of files to the sandbox
async function sync(files, sandbox, writePerm) {
    console.error('Syncing...')
    const startTime = perf_hooks.performance.now()
    const totalSynced = (
        await Promise.all(
            files.map(async (file) => {
                const src = path.join(RUNFILES_ROOT, file)
                const dst = path.join(sandbox, file)
                return await syncRecursive(src, dst, writePerm)
            })
        )
    ).reduce((s, t) => s + t, 0)
    var endTime = perf_hooks.performance.now()
    console.error(
        `${totalSynced} file${
            totalSynced > 1 ? 's' : ''
        } synced in ${Math.round(endTime - startTime)} ms`
    )
}

async function checkIfModified(files) {
    const totalModified = (
        await Promise.all(
            files.map(async (file) => {
                const root = path.join(RUNFILES_ROOT, file)
                return await walkModifiedItems(root)
            })
        )
    ).reduce((s, t) => s + t, 0)
    return totalModified > 0
}

class ProcessRunner {
    constructor(command, args, options) {
        this._command = command
        this._args = args
        this._options = options
        this._process = null
        this._handleClose = this._handleClose.bind(this)

        this.onerror = null

        this._run()
    }

    restart() {
        this._process?.off('close', this._handleClose)
        this._kill()
        this._run()
    }

    _handleClose(code) {
        this?.onerror(code)
    }

    _run() {
        if (this._process) return
        this._process = child_process.spawn(
            this._command,
            this._args,
            this._options
        )
        this._process.on('close', this._handleClose)
    }

    _kill() {
        this._process?.kill()
        this._process = null
    }
}

async function main(args, sandbox) {
    console.error(
        `\n\nStarting js_run_devserver ${process.env.JS_BINARY__TARGET}`
    )

    const configPath = path.join(RUNFILES_ROOT, args[0])

    const config = JSON.parse(await fs.promises.readFile(configPath))

    await checkIfModified(config.files_to_restart_on_change)
    await sync(
        config.data_files,
        sandbox,
        config.grant_sandbox_write_permissions
    )

    return new Promise((resolve) => {
        const cwd = process.env.JS_BINARY__CHDIR
            ? path.join(sandbox, process.env.JS_BINARY__CHDIR)
            : sandbox

        const tool = config.tool
            ? path.join(RUNFILES_ROOT, config.tool)
            : config.command

        const toolArgs = args.slice(1)

        console.error(`Running '${tool} ${toolArgs.join(' ')}' in ${cwd}\n\n`)

        const env = {
            ...process.env,
            BAZEL_BINDIR: '.', // no load bearing but it may be depended on by users
            JS_BINARY__CHDIR: '',
            JS_BINARY__NO_CD_BINDIR: '1',
        }

        if (config.use_execroot_entry_point) {
            // Configure a potential js_binary tool to use the execroot entry_point.
            // js_run_devserver is a special case where we need to set the BAZEL_BINDIR
            // to determine the execroot entry point but since the tool is running
            // in a custom sandbox we don't want to cd into the BAZEL_BINDIR in the launcher
            // (JS_BINARY__NO_CD_BINDIR is set above)
            env['JS_BINARY__USE_EXECROOT_ENTRY_POINT'] = '1'
            env['BAZEL_BINDIR'] = config.bazel_bindir
            if (config.allow_execroot_entry_point_with_no_copy_data_to_bin) {
                env[
                    'JS_BINARY__ALLOW_EXECROOT_ENTRY_POINT_WITH_NO_COPY_DATA_TO_BIN'
                ] = '1'
            }
        }

        const proc = new ProcessRunner(tool, toolArgs, {
            cwd: cwd,
            stdio: 'inherit',
            env: env,
        })

        proc.onerror = (code) => {
            console.error(`child tool process exited with code ${code}`)
            resolve()
            process.exit(code)
        }

        let syncing = Promise.resolve()
        process.stdin.on('data', async (chunk) => {
            try {
                const chunkString = chunk.toString()
                if (chunkString.includes('IBAZEL_BUILD_COMPLETED SUCCESS')) {
                    if (process.env.JS_BINARY__LOG_DEBUG) {
                        console.error('IBAZEL_BUILD_COMPLETED SUCCESS')
                    }
                    // Chain promises via syncing.then()
                    syncing = syncing
                        .then(() =>
                            checkIfModified(config.files_to_restart_on_change)
                        )
                        .then((modified) => {
                            if (modified) {
                                console.error('Restarting...')
                                proc.restart()
                            }
                        })
                        .then(() =>
                            sync(
                                // Re-parse the config file to get the latest list of data files to copy
                                JSON.parse(fs.readFileSync(configPath))
                                    .data_files,
                                sandbox,
                                config.grant_sandbox_write_permissions
                            )
                        )
                    // Await promise to catch any exceptions
                    await syncing
                } else if (chunkString.includes('IBAZEL_BUILD_STARTED')) {
                    if (process.env.JS_BINARY__LOG_DEBUG) {
                        console.error('IBAZEL_BUILD_STARTED')
                    }
                }
            } catch (e) {
                console.error(
                    `An error has occurred while incrementally syncing files. Error: ${e}`
                )
                process.exit(1)
            }
        })
    })
}

;(async () => {
    let sandbox
    try {
        sandbox = path.join(
            await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'js_run_devserver-')
            ),
            process.env.JS_BINARY__WORKSPACE
        )
        mkdirpSync(path.join(sandbox, process.env.JS_BINARY__CHDIR || ''))
        await main(process.argv.slice(2), sandbox)
    } catch (e) {
        console.error(e)
        process.exit(1)
    } finally {
        try {
            if (sandbox) {
                await fs.promises.rm(sandbox, { recursive: true })
            }
        } catch (e) {
            console.error(
                `An error has occurred while removing the sandbox folder at ${sandbox}. Error: ${e}`
            )
        }
    }
})()
