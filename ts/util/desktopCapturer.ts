// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-classes-per-file */

import { ipcRenderer, type DesktopCapturerSource } from 'electron';
import * as macScreenShare from '@indutny/mac-screen-share';

import * as log from '../logging/log';
import * as Errors from '../types/errors';
import type { PresentableSource } from '../types/Calling';
import type { LocalizerType } from '../types/Util';
import {
  REQUESTED_VIDEO_WIDTH,
  REQUESTED_VIDEO_HEIGHT,
  REQUESTED_VIDEO_FRAMERATE,
} from '../calling/constants';
import { strictAssert } from './assert';
import { explodePromise } from './explodePromise';
import { isNotNil } from './isNotNil';
import { drop } from './drop';

// Chrome-only API for now, thus a declaration:
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(options: { kind: 'video' });

  public writable: WritableStream;
}

enum Step {
  RequestingMedia = 'RequestingMedia',
  Done = 'Done',
  Error = 'Error',

  // Skipped on macOS Sequoia
  SelectingSource = 'SelectingSource',
  SelectedSource = 'SelectedSource',

  // macOS Sequoia
  NativeMacOS = 'NativeMacOS',
}

type State = Readonly<
  | {
      step: Step.RequestingMedia;
      promise: Promise<void>;
    }
  | {
      step: Step.SelectingSource;
      promise: Promise<void>;
      sources: ReadonlyArray<DesktopCapturerSource>;
      onSource: (source: DesktopCapturerSource | undefined) => void;
    }
  | {
      step: Step.SelectedSource;
      promise: Promise<void>;
    }
  | {
      step: Step.NativeMacOS;
      stream: macScreenShare.Stream;
    }
  | {
      step: Step.Done;
    }
  | {
      step: Step.Error;
    }
>;

export const liveCapturers = new Set<DesktopCapturer>();

export type IpcResponseType = Readonly<{
  id: string;
  sources: ReadonlyArray<DesktopCapturerSource>;
}>;

export type DesktopCapturerOptionsType = Readonly<{
  i18n: LocalizerType;
  onPresentableSources(sources: ReadonlyArray<PresentableSource>): void;
  onMediaStream(stream: MediaStream): void;
  onError(error: Error): void;
}>;

export type DesktopCapturerBaton = Readonly<{
  __desktop_capturer_baton: never;
}>;

export class DesktopCapturer {
  private state: State;

  private static isInitialized = false;

  // For use as a key in weak maps
  public readonly baton = {} as DesktopCapturerBaton;

  constructor(private readonly options: DesktopCapturerOptionsType) {
    if (!DesktopCapturer.isInitialized) {
      DesktopCapturer.initialize();
    }

    if (macScreenShare.isSupported) {
      this.state = {
        step: Step.NativeMacOS,
        stream: this.getNativeMacOSStream(),
      };
    } else {
      this.state = { step: Step.RequestingMedia, promise: this.getStream() };
    }
  }

  public abort(): void {
    if (this.state.step === Step.NativeMacOS) {
      this.state.stream.stop();
    }

    if (this.state.step === Step.SelectingSource) {
      this.state.onSource(undefined);
    }

    this.state = { step: Step.Error };
  }

  public selectSource(id: string): void {
    strictAssert(
      this.state.step === Step.SelectingSource,
      `Invalid state in "selectSource" ${this.state.step}`
    );

    const { promise, sources, onSource } = this.state;
    const source = id == null ? undefined : sources.find(s => s.id === id);
    this.state = { step: Step.SelectedSource, promise };

    onSource(source);
  }

  /** @internal */
  private onSources(
    sources: ReadonlyArray<DesktopCapturerSource>
  ): Promise<DesktopCapturerSource | undefined> {
    strictAssert(
      this.state.step === Step.RequestingMedia,
      `Invalid state in "onSources" ${this.state.step}`
    );

    const presentableSources = sources
      .map(source => {
        // If electron can't retrieve a thumbnail then it won't be able to
        // present this source so we filter these out.
        if (source.thumbnail.isEmpty()) {
          return undefined;
        }
        return {
          appIcon:
            source.appIcon && !source.appIcon.isEmpty()
              ? source.appIcon.toDataURL()
              : undefined,
          id: source.id,
          name: this.translateSourceName(source),
          isScreen: isScreenSource(source),
          thumbnail: source.thumbnail.toDataURL(),
        };
      })
      .filter(isNotNil);

    const { promise } = this.state;

    const { promise: source, resolve: onSource } = explodePromise<
      DesktopCapturerSource | undefined
    >();
    this.state = { step: Step.SelectingSource, promise, sources, onSource };

    this.options.onPresentableSources(presentableSources);
    return source;
  }

  private async getStream(): Promise<void> {
    liveCapturers.add(this);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: {
            max: REQUESTED_VIDEO_WIDTH,
            ideal: REQUESTED_VIDEO_WIDTH,
          },
          height: {
            max: REQUESTED_VIDEO_HEIGHT,
            ideal: REQUESTED_VIDEO_HEIGHT,
          },
          frameRate: {
            max: REQUESTED_VIDEO_FRAMERATE,
            ideal: REQUESTED_VIDEO_FRAMERATE,
          },
        },
      });

      strictAssert(
        this.state.step === Step.RequestingMedia ||
          this.state.step === Step.SelectedSource,
        `Invalid state in "getStream.success" ${this.state.step}`
      );

      this.options.onMediaStream(stream);
      this.state = { step: Step.Done };
    } catch (error) {
      strictAssert(
        this.state.step === Step.RequestingMedia ||
          this.state.step === Step.SelectedSource,
        `Invalid state in "getStream.error" ${this.state.step}`
      );
      this.options.onError(error);
      this.state = { step: Step.Error };
    } finally {
      liveCapturers.delete(this);
    }
  }

  private getNativeMacOSStream(): macScreenShare.Stream {
    const track = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = track.writable.getWriter();

    const mediaStream = new MediaStream();
    mediaStream.addTrack(track);

    let isRunning = false;

    const stream = new macScreenShare.Stream({
      width: REQUESTED_VIDEO_WIDTH,
      height: REQUESTED_VIDEO_HEIGHT,
      frameRate: REQUESTED_VIDEO_FRAMERATE,

      onStart: () => {
        isRunning = true;

        this.options.onMediaStream(mediaStream);
      },
      onStop() {
        if (!isRunning) {
          return;
        }
        isRunning = false;

        if (track.readyState === 'ended') {
          stream.stop();
          return;
        }
        drop(writer.close());
      },
      onFrame(frame, width, height) {
        if (!isRunning) {
          return;
        }
        if (track.readyState === 'ended') {
          stream.stop();
          return;
        }

        const videoFrame = new VideoFrame(frame, {
          format: 'NV12',
          codedWidth: width,
          codedHeight: height,
          timestamp: 0,
        });
        drop(writer.write(videoFrame));
      },
    });

    return stream;
  }

  private translateSourceName(source: DesktopCapturerSource): string {
    const { i18n } = this.options;

    const { name } = source;
    if (!isScreenSource(source)) {
      return name;
    }

    if (name === 'Entire Screen') {
      return i18n('icu:calling__SelectPresentingSourcesModal--entireScreen');
    }

    const match = name.match(/^Screen (\d+)$/);
    if (match) {
      return i18n('icu:calling__SelectPresentingSourcesModal--screen', {
        id: match[1],
      });
    }

    return name;
  }

  private static initialize(): void {
    DesktopCapturer.isInitialized = true;

    ipcRenderer.on(
      'select-capture-sources',
      async (_, { id, sources }: IpcResponseType) => {
        let selected: DesktopCapturerSource | undefined;
        try {
          const { value: capturer, done } = liveCapturers.values().next();
          strictAssert(!done, 'No capturer available for incoming sources');
          liveCapturers.delete(capturer);

          selected = await capturer.onSources(sources);
        } catch (error) {
          log.error(
            'desktopCapturer: failed to get the source',
            Errors.toLogFormat(error)
          );
        }
        ipcRenderer.send(`select-capture-sources:${id}:response`, selected);
      }
    );
  }
}

function isScreenSource(source: DesktopCapturerSource): boolean {
  return source.id.startsWith('screen');
}