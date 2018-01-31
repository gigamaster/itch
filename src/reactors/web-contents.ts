import { actions } from "../actions";
import { Watcher } from "./watcher";
import * as url from "url";

import { webContents, BrowserWindow } from "electron";

import urlParser from "../util/url";

import rootLogger from "../logger";
import { request } from "../net/request";
import { IStore } from "../types/index";
const logger = rootLogger.child({ name: "web-contents" });

import createContextMenu from "./web-contents-context-menu";
import { ITabWeb } from "../types/tab-data";
import { DB } from "../db/index";
import { doSave } from "./navigation/save-password-and-secret";
import { Space } from "../helpers/space";

const SHOW_DEVTOOLS = parseInt(process.env.DEVTOOLS, 10) > 1;
const DONT_SHOW_WEBVIEWS = process.env.ITCH_DONT_SHOW_WEBVIEWS === "1";

function withWebContents(
  store: IStore,
  tab: string,
  cb: (wc: Electron.WebContents) => any
) {
  const sp = Space.fromStore(store, tab);

  const { webContentsId } = sp.web();
  if (!webContentsId) {
    return;
  }

  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    return;
  }

  cb(wc);
}

export default function(watcher: Watcher, db: DB) {
  watcher.on(actions.tabGotWebContents, async (store, action) => {
    const { tab, webContentsId } = action.payload;
    logger.debug(`Got webContents ${webContentsId} for tab ${tab}`);

    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      logger.warn(`Couldn't get webContents for tab ${tab}`);
      return;
    }

    let pushWeb = (web: Partial<ITabWeb>) => {
      store.dispatch(
        actions.tabDataFetched({
          tab,
          data: {
            web,
          },
        })
      );
    };
    pushWeb({ webContentsId, loading: wc.isLoading() });

    const sp = Space.fromStore(store, tab);
    const didNavigate = url => {
      if (sp.isFrozen()) {
        return;
      }

      if (url !== "about:blank") {
        const resource = parseWellKnownUrl(url);
        store.dispatch(
          actions.evolveTab({
            tab,
            url,
            resource,
            replace: false,
          })
        );
      }
      pushWeb({
        url,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      });
    };

    didNavigate(wc.getURL());

    if (sp.isFrozen()) {
      wc.on("will-navigate", (ev, url) => {
        console.log("will-navigate!", url);
        ev.preventDefault();
        store.dispatch(actions.navigate({ url }));
      });
    }

    // FIXME: this used to be `dom-ready` but it doesn't seem to fire
    // on webcontents for webview.

    wc.once("did-finish-load", () => {
      logger.debug(`did-finish-load (once)`);
      if (DONT_SHOW_WEBVIEWS) {
        return;
      }

      createContextMenu(wc, store);

      if (SHOW_DEVTOOLS) {
        wc.openDevTools({ mode: "detach" });
      }
    });

    wc.on("did-finish-load", () => {
      logger.debug(
        `did-finish-load (on), executing injected js and analyzing page`
      );
      wc.executeJavaScript(
        `window.__itchInit && window.__itchInit(${JSON.stringify(tab)})`,
        false
      );

      store.dispatch(
        actions.analyzePage({
          tab,
          url: wc.getURL(),
          iframe: false,
        })
      );
    });

    wc.on("did-start-loading", () => {
      logger.debug(`did-start-loading`);
      pushWeb({ loading: true });
    });

    wc.on("did-stop-loading", () => {
      logger.debug(`did-stop-loading`);
      pushWeb({ loading: false });
    });

    // FIXME: page-title-updated isn't documented, see https://github.com/electron/electron/issues/10040
    // also, with electron@1.7.5, it seems to not always fire. whereas webview's event does.

    wc.on("page-favicon-updated", (ev, favicons) => {
      logger.debug(`Got page-favicon-updated: ${favicons[0]}`);
      pushWeb({ favicon: favicons[0] });
    });

    wc.on("did-navigate", (e, url) => {
      logger.debug(`did-navigate to ${url}`);
      didNavigate(url);
    });
    wc.on("did-navigate-in-page", (e, url, isMainFrame) => {
      logger.debug(
        `did-navigate-in-page to ${url}, isMainFrame = ${isMainFrame}`
      );
      if (isMainFrame) {
        didNavigate(url);
      }
    });

    wc.on(
      "new-window",
      (ev, url, frameName, disposition, options, additionalFeatures) => {
        const background = disposition === "background-tab";
        store.dispatch(actions.navigate({ url, background }));
      }
    );

    wc.on(
      "navigation-entry-commited" as any,
      (event, url, inPage, replaceEntry) => {
        logger.debug(
          `navigation entry committed: ${url}, inPage = ${inPage}, replaceEntry = ${replaceEntry}`
        );
        logger.debug(
          `history is now: ${JSON.stringify((wc as any).history, null, 2)}`
        );
        logger.debug(`currentIndex: ${(wc as any).currentIndex}`);
        logger.debug(`inPageIndex: ${(wc as any).inPageIndex}`);
      }
    );
  });

  watcher.on(actions.analyzePage, async (store, action) => {
    const { tab, url, iframe } = action.payload;
    withWebContents(store, tab, async wc => {
      logger.debug(`Analyzing ${url}, iframe? ${iframe}`);
      const sp = Space.fromStore(store, tab);
      if (sp.isFrozen()) {
        logger.debug(`Is frozen, won't analyze`);
        return;
      }

      const onNewPath = resource => {
        if (resource) {
          // FIXME: we need this to be better - analyze can finish after we've already navigated away
          // so we need to only set resource if the url is what we think it is
          logger.debug(`Got resource ${resource}`);
          store.dispatch(
            actions.evolveTab({
              tab: tab,
              url,
              resource,
              replace: true,
            })
          );

          const parsed = urlParser.parse(url);
          if (parsed.search) {
            doSave(resource, parsed.search, db);
          }
        }
      };

      if (iframe) {
        const querylessUrl = url.replace(/\?.*$/, "");
        const dataUrl = `${querylessUrl}/data.json`;
        const data = await request("get", dataUrl, {}, { format: "json" });
        logger.debug(`iframe page data = ${JSON.stringify(data, null, 2)}`);
        if (data && data.body && data.body.id) {
          onNewPath(`games/${data.body.id}`);
        }
      } else {
        logger.debug(`Executing javascript on page`);
        const code = `(document.querySelector('meta[name="itch:path"]') || {}).content`;
        const newPath = await wc.executeJavaScript(code);
        logger.debug(`result of await: ${newPath}`);
        onNewPath(newPath);
      }
    });
  });

  watcher.on(actions.trigger, async (store, action) => {
    let { tab, command } = action.payload;
    if (!tab) {
      tab = store.getState().session.navigation.tab;
    }
    logger.debug(`Got command ${command} for tab ${tab}`);

    withWebContents(store, tab, wc => {
      let pushWeb = (web: Partial<ITabWeb>) => {
        store.dispatch(
          actions.tabDataFetched({
            tab,
            data: {
              web,
            },
          })
        );
      };

      switch (command) {
        case "goBack": {
          wc.goBack();
          break;
        }
        case "goForward": {
          wc.goForward();
          break;
        }
        case "reload": {
          wc.reload();
          break;
        }
        case "stop": {
          wc.stop();
          break;
        }
        case "location": {
          pushWeb({ editingAddress: true });
          break;
        }
        case "back": {
          pushWeb({ editingAddress: false });
          break;
        }
      }
    });
  });

  watcher.on(actions.openDevTools, async (store, action) => {
    const { forApp } = action.payload;
    if (forApp) {
      const bw = BrowserWindow.getFocusedWindow();
      if (bw && bw.webContents) {
        bw.webContents.openDevTools({ mode: "detach" });
      }
    } else {
      const { tab } = store.getState().session.navigation;
      withWebContents(store, tab, wc => {
        wc.openDevTools({ mode: "bottom" });
      });
    }
  });
}

const COLLECTION_URL_RE = /^\/c\/([0-9]+)/;

function parseWellKnownUrl(rawurl: string): string {
  try {
    const u = url.parse(rawurl);
    if (u.hostname === "itch.io") {
      const matches = COLLECTION_URL_RE.exec(u.pathname);
      if (matches) {
        return `collections/${matches[1]}`;
      }
    }
  } catch (e) {
    logger.warn(`Could not parse url: ${rawurl}`);
  }

  return null;
}
