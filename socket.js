// socket.js

// private
var debug = require('debug')
var debugWebSSH2 = require('debug')('WebSSH2')
var SSH = require('ssh2').Client
var fs = require('fs')
var hostkeys = JSON.parse(fs.readFileSync('./hostkeyhashes.json', 'utf8'))
var termCols, termRows
var shell= require('shelljs');

// public
module.exports = function socket (socket) {
  // if websocket connection arrives without an express session, kill it
  if (!socket.request.session) {
    socket.emit('401 UNAUTHORIZED')
    debugWebSSH2('SOCKET: No Express Session / REJECTED')
    socket.disconnect(true)
    return
  }
  var conn = new SSH()
  var hostn= shell.exec('facter ' + socket.request.session.ssh.host , {silent:true}).stdout;
  socket.on('geometry', function socketOnGeometry (cols, rows) {
    termCols = cols
    termRows = rows
  })
  conn.on('banner', function connOnBanner (data) {
        // need to convert to cr/lf for proper formatting
    data = data.replace(/\r?\n/g, '\r\n')
    socket.emit('data', data.toString('utf-8'))
  })

  conn.on('ready', function connOnReady () {
    console.log('WebSSH2 Login: user=' + socket.request.session.ssh.user + ' from=' + socket.handshake.address + ' host=' + hostn + ' port=' + socket.request.session.ssh.port + ' sessionID=' + socket.request.sessionID + '/' + socket.id + ' allowreplay=' + socket.request.session.ssh.allowreplay + ' term=' + socket.request.session.ssh.term)
    socket.emit('title', 'ssh://' + hostn)
    if (socket.request.session.ssh.header.background) socket.emit('headerBackground', socket.request.session.ssh.header.background)
    if (socket.request.session.ssh.header.name) socket.emit('header', socket.request.session.ssh.header.name)
    socket.emit('footer', 'ssh://' + socket.request.session.ssh.user + '@' + hostn + ':' + socket.request.session.ssh.port)
    socket.emit('status', 'SSH CONNECTION ESTABLISHED')
    socket.emit('statusBackground', 'green')
    socket.emit('allowreplay', socket.request.session.ssh.allowreplay)
    conn.shell({
      term: socket.request.session.ssh.term,
      cols: termCols,
      rows: termRows
    }, function connShell (err, stream) {
      if (err) {
        SSHerror('EXEC ERROR' + err)
        conn.end()
        return
      }
      // poc to log commands from client
      if (socket.request.session.ssh.serverlog.client) var dataBuffer
      socket.on('data', function socketOnData (data) {
        stream.write(data)
        // poc to log commands from client
        if (socket.request.session.ssh.serverlog.client) {
          if (data === '\r') {
            console.log('serverlog.client: ' + socket.request.session.id + '/' + socket.id + ' host: ' + hostn + ' command: ' + dataBuffer)
            dataBuffer = undefined
          } else {
            dataBuffer = (dataBuffer) ? dataBuffer + data : data
          }
        }
      })
      socket.on('control', function socketOnControl (controlData) {
        switch (controlData) {
          case 'replayCredentials':
            stream.write(socket.request.session.ssh.pass + '\n')
          /* falls through */
          default:
            console.log('controlData: ' + controlData)
        }
      })
      socket.on('disconnecting', function socketOnDisconnecting (reason) { debugWebSSH2('SOCKET DISCONNECTING: ' + reason) })
      socket.on('disconnect', function socketOnDisconnect (reason) {
        debugWebSSH2('SOCKET DISCONNECT: ' + reason)
        err = { message: reason }
        SSHerror('CLIENT SOCKET DISCONNECT', err)
        conn.end()
        // socket.request.session.destroy()
      })
      socket.on('error', function socketOnError (err) {
        SSHerror('SOCKET ERROR', err)
        conn.end()
      })

      stream.on('data', function streamOnData (data) { socket.emit('data', data.toString('utf-8')) })
      stream.on('close', function streamOnClose (code, signal) {
        err = { message: ((code || signal) ? (((code) ? 'CODE: ' + code : '') + ((code && signal) ? ' ' : '') + ((signal) ? 'SIGNAL: ' + signal : '')) : undefined) }
        SSHerror('STREAM CLOSE', err)
        conn.end()
      })
      stream.stderr.on('data', function streamStderrOnData (data) {
        console.log('STDERR: ' + data)
      })
    })
  })

  conn.on('end', function connOnEnd (err) { SSHerror('CONN END BY HOST', err) })
  conn.on('close', function connOnClose (err) { SSHerror('CONN CLOSE', err) })
  conn.on('error', function connOnError (err) { SSHerror('CONN ERROR', err) })
  conn.on('keyboard-interactive', function connOnKeyboardInteractive (name, instructions, instructionsLang, prompts, finish) {
    debugWebSSH2('conn.on(\'keyboard-interactive\')')
    finish([socket.request.session.ssh.pass])
  })
  if ( socket.request.session.ssh) {
    // console.log('hostkeys: ' + hostkeys[0].[0])
    conn.connect({
      host: hostn,
      port: socket.request.session.ssh.port,
      username: socket.request.session.ssh.user,
      password: socket.request.session.ssh.pass,
      tryKeyboard: true,
      algorithms: socket.request.session.ssh.algorithms,
      readyTimeout: socket.request.session.ssh.readyTimeout,
      hostHash: 'sha1',
      hostVerifier: function (hash) {
        if (socket.request.session.ssh.verify) {
          if (hash === hostkeys[hostn]) {
            return (verified = true)
          } else {
            err = { message: 'SSH HOST KEY HASH MISMATCH: ' + hash }
            console.error('WEBSSH2 contents of host key hashes: ', JSON.stringify(hostkeys))
            console.error('WEBSSH2 reported hash from ' + socket.request.session.ssh.host + ': ', hash)
            console.error('WEBSSH2  host key hash for ' + socket.request.session.ssh.host + ': ', hostkeys[socket.request.session.ssh.host])
            SSHerror('CONN CONNECT', err)
            return (verified = false)
          }
        } else {
          console.info('host key verification disabled. hash for host ' + socket.request.session.ssh.host + ': ', hash)
          return (noverify = true)
        }
      },
      keepaliveInterval: socket.request.session.ssh.keepaliveInterval,
      debug: debug('ssh2')
    })
  } else {
    debugWebSSH2('Attempt to connect without session.username/password or session varialbles defined, potentially previously abandoned client session. disconnecting websocket client.\r\nHandshake information: \r\n  ' + JSON.stringify(socket.handshake))
    socket.emit('ssherror', 'WEBSOCKET ERROR - Refresh the browser and try again')
    socket.request.session.destroy()
    socket.disconnect(true)
  }

  /**
  * Error handling for various events. Outputs error to client, logs to
  * server, destroys session and disconnects socket.
  * @param {string} myFunc Function calling this function
  * @param {object} err    error object or error message
  */
  function SSHerror (myFunc, err) {
    var theError
    if (socket.request.session) {
      // we just want the first error of the session to pass to the client
      socket.request.session.error = (socket.request.session.error) || ((err) ? err.message : undefined)
      theError = (socket.request.session.error) ? ': ' + socket.request.session.error : ''
      // log unsuccessful login attempt
      if (err && (err.level === 'client-authentication')) {
        console.log('WebSSH2 ' + 'error: Authentication failure'.red.bold +
          ' user=' + socket.request.session.ssh.user.yellow.bold.underline +
          ' from=' + socket.handshake.address.yellow.bold.underline)
      } else {
        console.log('WebSSH2 Logout: user=' + socket.request.session.ssh.user + ' from=' + socket.handshake.address + ' host=' + socket.request.session.ssh.host + ' port=' + socket.request.session.ssh.port + ' sessionID=' + socket.request.sessionID + '/' + socket.id + ' allowreplay=' + socket.request.session.ssh.allowreplay + ' term=' + socket.request.session.ssh.term)
        if (err) {
          theError = (err) ? ': ' + err.message : ''
          console.log('WebSSH2 error' + theError)
        }
      }
      socket.emit('ssherror', 'SSH ' + myFunc + theError)
      socket.request.session.destroy()
      socket.disconnect(true)
    } else {
      theError = (err) ? ': ' + err.message : ''
      socket.disconnect(true)
    }
    debugWebSSH2('SSHerror ' + myFunc + theError)
  }
}
