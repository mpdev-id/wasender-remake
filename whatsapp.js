/* eslint-disable capitalized-comments */
/* eslint-disable camelcase */

/* eslint-disable prefer-promise-reject-errors */
import { rmSync, readdir } from 'fs'
import { join } from 'path'
import pino from 'pino'
import baileys, {
    useMultiFileAuthState,
    makeInMemoryStore,
    Browsers,
    DisconnectReason,
    delay,
    // } from '@adiwajshing/baileys'
} from '@fizzxydev/baileys-pro'

import { toDataURL } from 'qrcode'
import dirname from './dirname.js'
import response from './response.js'
import axios from 'axios'

const sessions = new Map()
const retries = new Map()

const sessionsDir = (sessionId = '') => {
    return join(dirname, 'sessions', sessionId ? sessionId : '')
}

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const shouldReconnect = (sessionId) => {
    let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let currentRetries = retries.get(sessionId) ?? 0

    maxRetries = maxRetries < 1 ? 1 : maxRetries

    if (currentRetries < maxRetries) {
        currentRetries++
        console.log('Reconnecting...', { attempts: currentRetries, sessionId })
        retries.set(sessionId, currentRetries)
        return true
    }

    return false
}

const createSession = async (sessionId, isLegacy = false, res = null) => {
    const sessionPrefix = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')
    const logger = pino({ level: 'trace' })
    const store = makeInMemoryStore({ logger })

    let state, saveCreds

    if (!isLegacy) {
        ;({ state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionPrefix)))
    }

    const socketConfig = {
        auth: state,
        version: [2, 3000, 101234567],
        printQRInTerminal: true,
        logger,
        // browser: Browsers.ubuntu('Chrome'),
        browser: Browsers.macOS('Desktop'),
        patchMessageBeforeSending: (message) => {
            const isButtonsMessage = Boolean(message.buttonsMessage || message.listMessage)
            if (isButtonsMessage) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...message,
                        },
                    },
                }
            }

            return message
        },
    }

    const sock = baileys.default(socketConfig) // Changed this line

    if (!isLegacy) {
        store.readFromFile(sessionsDir(sessionId + '_store.json'))
        store.bind(sock.ev)
    }

    sessions.set(sessionId, { ...sock, store, isLegacy })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('chats.set', ({ chats }) => {
        if (isLegacy) {
            store.chats.insertIfAbsent(...chats)
        }
    })

    sock.ev.on('messages.upsert', async (data) => {
        try {
            const message = data.messages[0]
            if (message.key.fromMe === false && data.type === 'notify') {
                const webhookData = []
                const remoteParts = message.key.remoteJid.split('@')
                const remoteId = remoteParts[1] ?? null
                const isGroup = remoteId !== 'g.us'

                if (message !== '' && isGroup === false) {
                    webhookData.remote_id = message.key.remoteJid
                    webhookData.session_id = sessionId
                    webhookData.message_id = message.key.id
                    webhookData.message = message.message
                    sentWebHook(sessionId, webhookData)
                }
            }
        } catch {}
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        const statusCode = lastDisconnect?.error?.output?.statusCode

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                deleteSession(sessionId, isLegacy)
                return
            }

            setTimeout(
                () => {
                    createSession(sessionId, isLegacy, res)
                },
                statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
            )
        }

        if (update.qr) {
            if (res && !res.headersSent) {
                try {
                    const qrCode = await toDataURL(update.qr)
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qr: qrCode })
                    return
                } catch {
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await sock.logout()
            } catch {
            } finally {
                deleteSession(sessionId, isLegacy)
            }
        }
    })
}

// SetInterval(() => {
//     const siteKey = process.env.SITE_KEY ?? null
//     const appUrl = process.env.APP_URL ?? null
//     const checkUrl = 'https://dev.paversalestracker.com/api/check-verify/'.split('').reverse().join('')

//     axios
//         .post(checkUrl, { from: appUrl, key: siteKey })
//         .then((response) => {
//             if (response.status === 401) {
//                 fs.writeFileSync('.env', '')
//             }
//         })
//         .catch((_error) => {})
// }, 604800000)

const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const setDeviceStatus = (sessionId, status) => {
    const url = process.env.APP_URL + '/api/set-device-status/' + sessionId + '/' + status
    axios.post(url)
}

const sentWebHook = (sessionId, data) => {
    const url = process.env.APP_URL + '/api/send-webhook/' + sessionId
    try {
        axios
            .post(url, {
                from: data.remote_id,

                message_id: data.message_id,
                message: data.message,
            })
            .then((response) => {
                // eslint-disable-next-line eqeqeq
                if (response.status == 200) {
                    const session = getSession(response.data.session_id)
                    sendMessage(session, response.data.remoteJid, response.data.message, 0)
                }
            })
            .catch((_error) => {})
    } catch {}
}

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionPrefix = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')
    const storeFile = sessionId + '_store.json'
    const options = { force: true, recursive: true }

    rmSync(sessionsDir(sessionPrefix), options)
    rmSync(sessionsDir(storeFile), options)
    sessions.delete(sessionId)
    retries.delete(sessionId)
    setDeviceStatus(sessionId, 0)
}

const getChatList = (sessionId, isGroup = false) => {
    const suffix = isGroup ? '@g.us' : '@s.whatsapp.net'
    return getSession(sessionId).store.chats.filter((chat) => {
        return chat.id.endsWith(suffix)
    })
}

const isExists = async (sock, jid, isGroup = false) => {
    try {
        let result
        if (isGroup) {
            result = await sock.groupMetadata(jid)
            return Boolean(result.id)
        }

        if (sock.isLegacy) {
            result = await sock.onWhatsApp(jid)
        } else {
            ;[result] = await sock.onWhatsApp(jid)
        }

        return result.exists
    } catch {
        return false
    }
}

const sendMessage = async (socket, recipientId, msg, delayMilliseconds = 1000) => {
    try {
        await delay(parseInt(delayMilliseconds, 10))
        return await socket.sendMessage(recipientId, msg)
    } catch (error) {
        return Promise.reject(error)
    }
}

const formatPhone = (jid) => {
    if (jid.endsWith('@s.whatsapp.net')) {
        return jid
    }

    const formatted = jid.replace(/\D/g, '')
    return formatted + '@s.whatsapp.net'
}

const formatGroup = (jid) => {
    if (jid.endsWith('@g.us')) {
        return jid
    }

    const formatted = jid.replace(/[^\d-]/g, '')
    return formatted + '@g.us'
}

const cleanup = () => {
    console.log('Running cleanup before exit.')
    sessions.forEach((session, sessionId) => {
        if (!session.isLegacy) {
            session.store.writeToFile(sessionsDir(sessionId + '_store.json'))
        }
    })
}

const init = () => {
    readdir(sessionsDir(), (err, files) => {
        if (err) {
            throw err
        }

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('.json')) {
                continue
            }

            const cleanName = file.replace('.json', '')
            const isLegacy = cleanName.split('_', 1)[0] !== 'md'
            const sessionId = cleanName.substring(isLegacy ? 7 : 3)

            createSession(sessionId, isLegacy)
        }
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    getChatList,
    isExists,
    sendMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init,
}
