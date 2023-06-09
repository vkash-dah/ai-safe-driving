import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
import '@mediapipe/face_mesh';
import '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import {
  SupportedModels,
  FaceLandmarksDetector,
  createDetector,
  Face,
  Keypoint,
} from '@tensorflow-models/face-landmarks-detection';
import { interval, map, sampleTime } from 'rxjs';
import { Subject } from 'rxjs';
import { OnDestroy } from '@angular/core';
import { takeUntil } from 'rxjs';
import { auditTime } from 'rxjs';
import { Observable } from 'rxjs';
import { combineLatest } from 'rxjs';
import { bufferTime } from 'rxjs';
import { BehaviorSubject } from 'rxjs';

@Component({
  selector: 'app-demo',
  templateUrl: './demo.component.html',
  styleUrls: ['./demo.component.scss'],
})
export class DemoComponent implements AfterViewInit, OnDestroy {
  /**
   * Canvas Ref element
   */
  @ViewChild('canvasRef')
  public canvasRef!: ElementRef;

  /**
   * Audio Ref element
   */
  @ViewChild('audioRef')
  public audioRef!: ElementRef;

  /**
   * Canvas context
   */
  private context: CanvasRenderingContext2D = null;

  /**
   * Getter for canvas element
   */
  private get canvas(): HTMLCanvasElement {
    return this.canvasRef.nativeElement;
  }

  /**
   * Video element
   */
  private videoEl: HTMLVideoElement = null;

  /**
   * Detector
   */
  private detector: FaceLandmarksDetector = null;

  /**
   * Canvas Image Data
   */
  private get canvasImageData(): ImageData {
    const { width, height } = this.canvas;
    return this.context.getImageData(0, 0, width, height);
  }

  /**
   * Destroy subject
   */
  private destroy$: Subject<void> = new Subject();

  /**
   * Keypoints
   */
  private keyPoints$: Subject<Keypoint[]> = new Subject();

  private leftEyeClose$: Subject<boolean> = new Subject();

  private righEyeClose$: Subject<boolean> = new Subject();

  public sleeping$: Observable<boolean> = combineLatest([this.leftEyeClose$, this.righEyeClose$]).pipe(
    sampleTime(2000),
    map((values: boolean[]) => values[0] && values[1])
  );

  public blinkingRate$: Observable<number> = combineLatest([this.leftEyeClose$, this.righEyeClose$]).pipe(
    map((values: boolean[]) => values[0] || values[1]),
    bufferTime(10000),
    map((values: boolean[]) => {
      let blinkCount: number = 0;
      for (let i = 0; i < values.length - 1; i++) {
        blinkCount = values[i] !== values[i + 1] ? blinkCount + 1 : blinkCount;
      }
      return blinkCount * 6;
    })
  );

  /**
   * Mouth open subject
   */
  private mouthOpen$: Subject<boolean> = new Subject();

  /**
   * calculate number of yawns
   */
  public yawns$: BehaviorSubject<number> = new BehaviorSubject(0);

  private faceMovement$: Subject<boolean> = new Subject();

  public distractionCount$: BehaviorSubject<number> = new BehaviorSubject(0);

  constructor() {}

  public async ngAfterViewInit(): Promise<void> {
    this.context = this.canvas.getContext('2d');
    await this.initVideoStream();
    this.detector = await createDetector(SupportedModels.MediaPipeFaceMesh, {
      runtime: 'mediapipe',
      solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh',
      refineLandmarks: true,
    });
    this.detectFace();
    this.detectDrowsyness();
    this.playAudioOnSleeping();
    this.countYawns();
    this.countDistractions();
  }

  private async initVideoStream(): Promise<void> {
    // Get the user's camera
    const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });

    // Set the video element's source to the camera stream
    this.videoEl = document.createElement('video');
    this.videoEl.srcObject = stream;
    this.videoEl.play();
  }

  /**
   * Detect face
   */
  private detectFace(): void {
    const { width, height } = this.canvas;
    interval(16.7)
      .pipe(takeUntil(this.destroy$))
      .subscribe(async () => {
        this.context.drawImage(this.videoEl, 0, 0, width, height);
        await this.detectEyePoints();
      });
  }

  /**
   * Get eye key points
   */
  private async detectEyePoints(): Promise<void> {
    const faces: Face[] = await this.detector.estimateFaces(this.canvasImageData, {
      flipHorizontal: false,
    });
    if (!faces[0]) {
      return null;
    }
    const points = faces?.[0].keypoints.filter((e) => ['leftEye', 'rightEye', 'lips'].includes(e.name));
    if (!points) {
      return;
    }
    for (let i = 0; i < points.length; i++) {
      const { x, y, z } = points[i];
      this.context.fillStyle = 'green';
      this.context.fillRect(x, y, 3, 3);
    }
    this.keyPoints$.next(faces?.[0].keypoints);
  }

  /**
   * Get Euclidean Distance between two keypoints
   * @param p1 keypoint p1
   * @param p2 keypoint p2
   * @returns
   */
  private getDistance(p1: Keypoint, p2: Keypoint): number {
    const a: number = p1.x - p2.x;
    const b: number = p1.y - p2.y;
    return Math.sqrt(a * a + b * b);
  }

  /**
   * Get eye aspect ratio
   * @param points
   * @returns
   */
  private getEyeAspectRatio(points: Keypoint[]): number {
    const h: number = this.getDistance(points[1], points[2]);
    const v1: number = this.getDistance(points[3], points[11]);
    const v2: number = this.getDistance(points[5], points[9]);
    return (v1 + v2) / (2 * h);
  }

  /**
   * Get lips aspect ratio
   * @param points
   * @returns
   */
  private calcMouthOpen(points: Keypoint[]): boolean {
    const p1x: number = (points[0].x + points[1].x) / 2;
    const p1y: number = (points[0].y + points[1].y) / 2;
    const p2x: number = (points[3].x + points[2].x) / 2;
    const p2y: number = (points[3].y + points[2].y) / 2;
    const distance: number = this.getDistance({ x: p1x, y: p1y }, { x: p2x, y: p2y });
    return distance > 40;
  }

  /**
   * Play audio on sleeping
   */
  private playAudioOnSleeping(): void {
    this.sleeping$.pipe(takeUntil(this.destroy$)).subscribe((isSleeping: boolean) => {
      const audioEl: HTMLAudioElement = this.audioRef.nativeElement;
      if (isSleeping) {
        audioEl.loop = true;
        audioEl.play();
      } else {
        audioEl.pause();
        audioEl.currentTime = 0;
      }
    });
  }

  private detectDrowsyness(): void {
    this.keyPoints$.pipe(takeUntil(this.destroy$), auditTime(50)).subscribe((keyPoints: Keypoint[]) => {
      const leftRatio: number = this.getEyeAspectRatio(keyPoints.filter((e) => e.name === 'leftEye'));
      const rightRatio: number = this.getEyeAspectRatio(keyPoints.filter((e) => e.name === 'rightEye'));
      this.leftEyeClose$.next(leftRatio < 0.2);
      this.righEyeClose$.next(rightRatio < 0.2);
      this.mouthOpen$.next(this.calcMouthOpen(keyPoints.filter((e) => e.name === 'lips')));
      const nosePoint: Keypoint = keyPoints[3];
      const facePoints: Keypoint[] = keyPoints.filter((e) => e.name === 'faceOval');
      const leftDist: number = this.getDistance(nosePoint, facePoints[23]);
      const rightDist: number = this.getDistance(nosePoint, facePoints[5]);
      const topDownDist: number = this.getDistance(facePoints[0], facePoints[14]);
      this.faceMovement$.next(leftDist / topDownDist < 0.25 || rightDist / topDownDist < 0.25);
    });
  }

  private countYawns(): void {
    this.mouthOpen$.pipe(takeUntil(this.destroy$), auditTime(1000)).subscribe((value: boolean) => {
      this.yawns$.next(this.yawns$.value + (value ? 1 : 0));
    });
  }

  private countDistractions(): void {
    this.faceMovement$.pipe(takeUntil(this.destroy$), sampleTime(1000)).subscribe((value: boolean) => {
      if (value) {
        this.distractionCount$.next(this.distractionCount$.value + 1);
      }
    });
  }

  /**
   * On Destroy
   */
  public ngOnDestroy(): void {
    this.destroy$.next();
  }
}
