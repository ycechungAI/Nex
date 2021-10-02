
const { app, BrowserWindow, ipcMain, session, Menu } = require('electron')
const isDev = require('electron-is-dev')
const { ElectronBlocker } = require('@cliqz/adblocker-electron')
const fetch = require('cross-fetch')
const contextMenu = require('electron-context-menu')
const unusedFilename = require('unused-filename')
const path = require('path')
const preference = require('./functions/config')
require('./functions/notifier')
require('./functions/events')
require('./functions/tor')

let downloads = {}
let mainWindow, newWindow

if (preference.getPreference().isTorEnabled) {
  app.commandLine.appendSwitch('proxy-server', 'socks5://127.0.0.1:9050')
}

app.on('window-all-closed', function () {
  app.quit()
})

newwindow = () => {
  newWindow = new BrowserWindow({
    title: 'Nex Browser',
    titleBarStyle: 'hiddenInset',
    show: false,
    icon: path.join(__dirname, '/icon.png'),
    resizable: true,
    width: 1000,
    height: 600,
    minWidth: 700,
    minHeight: 350,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true
    }
  })
  let menuTemplate = [
    {
      label: 'Menu',
      submenu: [
        {
          label: 'Clear session and Reload',
          accelerator: 'CommandOrControl+D',
          click () {
            session.fromPartition('temp-in-memory').clearCache()
            session.fromPartition('temp-in-memory').clearStorageData()
            newWindow.reload()
          }
        },
        {
          label: 'Focus URLbar',
          accelerator: 'CommandOrControl+L',
          click () {
            mainWindow.webContents.send('focusURLbar', {})
          }
        },
        {
          label: 'Add a new tab',
          accelerator: 'CommandOrControl+T',
          click () {
            mainWindow.webContents.send('newTab', {})
          }
        },
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))
  if (isDev) {
    newWindow.loadURL('http://localhost:3000')
    newWindow.openDevTools({ mode: 'detach' })
  } else {
    newWindow.loadFile('./build/index.html')
    //newWindow.openDevTools()
  }
  newWindow.once('ready-to-show', () => {
    newWindow.show()
    newWindow.maximize()
  })

  newWindow.webContents.on('did-attach-webview', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      /*Remove urlencoded characters from url. If bing search engine is used, 
      it adds 'https://www.bing.com/newtabredir?url=' infront of the the url 
      in new-window event, remove it.*/
      url = decodeURIComponent(
        url.replace('https://www.bing.com/newtabredir?url=', '')
      )
      mainWindow.webContents.send('openInNewtab', url)
      return { action: 'deny' }
    })
  })
  return newWindow
}

updateDownloadList = () => {
  /*downloads gets destroyed when Nex is restarting*/
  if (!downloads) return
  let sortedDownloads = {}
  Object.keys(downloads)
    .sort((a, b) => b - a)
    .forEach(function (key) {
      sortedDownloads[key] = downloads[key]
    })
  mainWindow.webContents.send('downloadsChanged', sortedDownloads)
}
ipcMain.on('getDownloads', event => {
  updateDownloadList()
})

app.on('ready', function () {
  /*Start check for Nex updates*/
  require('./functions/autoupdator')
  mainWindow = newwindow()
  /*Handle file download events from webview*/
  session
    .fromPartition('temp-in-memory')
    .on('will-download', (event, item, webContents) => {
      if (preference.getPreference().downloadLocation != 'ask') {
        var filepath = unusedFilename.sync(
          path.join(
            preference.getPreference().downloadLocation,
            item.getFilename()
          )
        )
        var newFilename = path.basename(filepath)
        item.setSavePath(filepath)
      }
      var downloadItem = {
        name: newFilename || item.getFilename(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        status: 'started'
      }
      var downloadID = new Date().getTime()
      downloads[downloadID] = downloadItem
      item.once('done', (event, state) => {
        if (state === 'completed') {
          downloadItem.path = item.getSavePath()
          downloads[downloadID].status = 'done'
        } else {
          if (state == 'cancelled') {
            delete downloads[downloadID]
          }
        }
        updateDownloadList()
      })
      item.on('updated', (event, state) => {
        if (state === 'progressing') {
          downloads[downloadID].receivedBytes = item.getReceivedBytes()
        }
        updateDownloadList()
      })
    })
  ipcMain.on('downloadURL', (event, url) => {
    mainWindow.webContents.downloadURL(url)
  })
  ipcMain.on('openNewTab', (event, url) => {
    mainWindow.webContents.send('openInNewtab', url)
  })

  /*Enable or disable adblocker based on user preference*/
  ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then(blocker => {
    if (preference.getPreference().isAdblockEnabled)
      blocker.enableBlockingInSession(session.fromPartition('temp-in-memory'))
    ipcMain.on('toggleAdblocker', (event, flag) => {
      if (flag)
        blocker.enableBlockingInSession(session.fromPartition('temp-in-memory'))
      else
        blocker.disableBlockingInSession(
          session.fromPartition('temp-in-memory')
        )
    })
  })

  /* Allow or deny special permissions like camera,mic,location etc. based on user preference*/
  session
    .fromPartition('temp-in-memory')
    .setPermissionRequestHandler((webContents, permission, callback) => {
      if (preference.getPreference().blockSpecialPermissions) {
        return callback(false)
      }
      return callback(true)
    })

  session
    .fromPartition('temp-in-memory')
    .setPermissionCheckHandler((webContents, permission) => {
      if (preference.getPreference().blockSpecialPermissions) {
        return false
      }
      return true
    })
})

/*electron-context-menu options*/
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() == 'webview') {
    contextMenu({
      window: {
        webContents: contents,
        inspectElement: contents.inspectElement.bind(contents)
      },
      prepend: (defaultActions, params, browserWindow) => [
        {
          label: 'Open in New Tab',
          visible: params.linkURL.trim().length > 0,
          click: () => {
            mainWindow.webContents.send('openInNewtab', params.linkURL)
          }
        },
        {
          label: 'Open Image in New Tab',
          visible: params.mediaType === 'image',
          click: () => {
            mainWindow.webContents.send('openInNewtab', params.srcURL)
          }
        }
      ],
      labels: {
        saveImage: 'Download Image',
        saveLinkAs: 'Download Link'
      },
      showSaveImage: true,
      showInspectElement: true,
      showCopyImageAddress: true,
      showCopyImage: true,
      showSaveLinkAs: true,
      showSearchWithGoogle: false
    })
  }
})
