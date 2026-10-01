import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree, useLoader } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import { useDrag } from '@use-gesture/react';
import * as THREE from 'three';
import { CINEMATIC_IMAGES } from '../data/cinematicImages';

// ============================================================================
// SCENE, GEOMETRY & PHYSICS CONSTANTS
// ============================================================================
const RADIUS = 3.35;               // Cylinder radius R
const CARDS_PER_TURN = 7;          // N cards per 360° revolution
const TOTAL_CARDS = 21;            // 3 full revolutions (3 × 7 = 21 cards)
const VERTICAL_STEP = 0.56;        // Vertical step per card (~3 tiers spanning +1.6, 0, -1.6)
const CARD_WIDTH = 2.35;           // Landscape ~16:9 width
const CARD_HEIGHT = 1.35;          // Landscape ~16:9 height
const CAMERA_FOV = 54;             // Perspective Camera FOV (between 50° and 60°)
const CAMERA_Z = 6.2;              // Camera at (0, 0, 6) looking at origin (0, 0, 0)
const AUTO_ROTATE_SPEED = 0.08;    // Constant angular velocity ω ≈ 0.08 rad/s
const DAMPING_FACTOR = 0.94;       // Inertia linear decay factor (0.92 ... 0.95)
const DRAG_SENSITIVITY = 0.0045;   // Horizontal pointer Δx to rotational velocity
const VELOCITY_THRESHOLD = 0.0005; // Threshold to blend back into idle auto-rotation

// ============================================================================
// CURVED CYLINDRICAL RIBBON CARD GEOMETRY
// Bends each 16:9 card along cylinder radius R with subtle helical contour
// ============================================================================
function createCurvedRibbonGeometry(
  width = CARD_WIDTH,
  height = CARD_HEIGHT,
  radius = RADIUS,
  flipUVX = false
) {
  const geometry = new THREE.PlaneGeometry(width, height, 48, 24);
  const pos = geometry.attributes.position;
  const uvs = geometry.attributes.uv;

  const dTheta = (2 * Math.PI) / CARDS_PER_TURN;
  const helixSlope = (VERTICAL_STEP / dTheta) * 0.32;

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);

    // Cylindrical arc curvature: x = R·sin(α), z = R·cos(α) - R
    const alpha = vx / radius;
    const curvedX = radius * Math.sin(alpha);
    const curvedZ = radius * Math.cos(alpha) - radius;

    // Subtle helical ribbon shear matching the 3D spiral contour
    const curvedY = vy - alpha * helixSlope;

    pos.setXYZ(i, curvedX, curvedY, curvedZ);

    if (flipUVX) {
      uvs.setX(i, 1 - uvs.getX(i));
    }
  }

  geometry.computeVertexNormals();
  return geometry;
}

// ============================================================================
// CAMERA RIG: PerspectiveCamera at (0, 0, 6) looking directly at Origin (0, 0, 0)
// ============================================================================
function CameraRig() {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 0, CAMERA_Z);
    camera.fov = CAMERA_FOV;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);

  return (
    <PerspectiveCamera
      makeDefault
      position={[0, 0, CAMERA_Z]}
      fov={CAMERA_FOV}
      near={0.1}
      far={100}
    />
  );
}

// ============================================================================
// INDIVIDUAL CURVED CARD MESH (Double-Sided Without Mirroring)
// ============================================================================
const HelicalCard = React.memo(function HelicalCard({
  cardIndex,
  texture,
  frontGeometry,
  backGeometry,
  meshRefs,
}) {
  const setGroupRef = useCallback(
    (node) => {
      meshRefs.current[cardIndex] = node;
    },
    [cardIndex, meshRefs]
  );

  return (
    <group ref={setGroupRef}>
      {/* Outward-facing surface */}
      <mesh geometry={frontGeometry}>
        <meshStandardMaterial
          map={texture}
          emissiveMap={texture}
          emissive="#ffffff"
          emissiveIntensity={0.42}
          roughness={0.35}
          metalness={0.05}
          side={THREE.FrontSide}
          fog={true}
        />
      </mesh>

      {/* Inward-facing concave surface (un-mirrored UVs for rear cylinder wall) */}
      <mesh geometry={backGeometry}>
        <meshStandardMaterial
          map={texture}
          emissiveMap={texture}
          emissive="#ffffff"
          emissiveIntensity={0.32}
          roughness={0.4}
          metalness={0.05}
          side={THREE.BackSide}
          fog={true}
        />
      </mesh>
    </group>
  );
});

// ============================================================================
// CYLINDRICAL SPATIAL SCENE & INERTIA PHYSICS
// ============================================================================
function CylindricalCarouselScene({ images, physicsRef }) {
  const meshRefs = useRef([]);
  const { gl } = useThree();

  const urls = useMemo(() => images.map((img) => img.url), [images]);
  const textures = useLoader(THREE.TextureLoader, urls);

  useMemo(() => {
    const maxAnisotropy = gl.capabilities.getMaxAnisotropy();
    textures.forEach((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = maxAnisotropy;
      tex.needsUpdate = true;
    });
  }, [textures, gl]);

  const { frontGeometry, backGeometry } = useMemo(
    () => ({
      frontGeometry: createCurvedRibbonGeometry(CARD_WIDTH, CARD_HEIGHT, RADIUS, false),
      backGeometry: createCurvedRibbonGeometry(CARD_WIDTH, CARD_HEIGHT, RADIUS, true),
    }),
    []
  );

  useEffect(() => {
    return () => {
      frontGeometry.dispose();
      backGeometry.dispose();
    };
  }, [frontGeometry, backGeometry]);

  // Sequence of textures mapped so adjacent & stacked tiers match the reference layout:
  // k=0 -> card-1 (red coat), k=1 -> card-2 (sunset jump), k=2 -> card-6 (storm horizon),
  // k=-4/3 -> card-5 (blue/red glass), k=-3/4 -> card-3 (red dress), k=-2/5 -> card-4 (light trails)
  const cardSlots = useMemo(() => {
    const pattern = [0, 1, 5, 4, 2, 3, 5];
    const half = Math.floor(TOTAL_CARDS / 2); // 10
    const list = [];

    for (let idx = 0; idx < TOTAL_CARDS; idx++) {
      const k = idx - half; // -10 .. +10
      const patternIdx = ((k % pattern.length) + pattern.length) % pattern.length;
      const texIdx = pattern[patternIdx] % textures.length;
      list.push({
        idx,
        baseK: k,
        texture: textures[texIdx],
      });
    }
    return list;
  }, [textures]);

  // Continuous auto-rotation, drag velocity, lerp damping & cylindrical positioning
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const phys = physicsRef.current;

    if (phys.isDragging) {
      // Pause auto-rotation while dragging
      phys.autoRotateBlend = THREE.MathUtils.lerp(phys.autoRotateBlend, 0, 0.25);

      // Translate horizontal pointer Δx into rotational velocity on Y-axis
      phys.velocity = THREE.MathUtils.lerp(phys.velocity, phys.dragDelta, 0.45);
      phys.rotationPhase += phys.velocity;

      // Decay instantaneous drag delta if pointer is stationary
      phys.dragDelta = THREE.MathUtils.lerp(phys.dragDelta, 0, 0.35);
    } else {
      // Momentum & Damping: apply linear decay factor (0.94) inside useFrame using lerp
      const frameDecay = Math.pow(DAMPING_FACTOR, dt * 60);
      phys.velocity = THREE.MathUtils.lerp(0, phys.velocity, frameDecay);

      // Blend back into slow idle auto-rotation (ω ≈ 0.08 rad/s) below threshold
      if (Math.abs(phys.velocity) < VELOCITY_THRESHOLD) {
        phys.autoRotateBlend = THREE.MathUtils.lerp(
          phys.autoRotateBlend,
          1.0,
          dt * 2.0
        );
      } else {
        phys.autoRotateBlend = THREE.MathUtils.lerp(
          phys.autoRotateBlend,
          0.0,
          dt * 5.0
        );
      }

      const idleDelta = AUTO_ROTATE_SPEED * dt * phys.autoRotateBlend;
      phys.rotationPhase += phys.velocity + idleDelta;
    }

    // Update each card's cylindrical position & orientation
    const dTheta = (2 * Math.PI) / CARDS_PER_TURN;
    const halfSpan = TOTAL_CARDS / 2;
    const shiftCards = phys.rotationPhase / dTheta;

    for (let i = 0; i < TOTAL_CARDS; i++) {
      const node = meshRefs.current[i];
      if (!node) continue;

      const rawK = cardSlots[i].baseK + shiftCards;
      const wrappedK =
        ((((rawK + halfSpan) % TOTAL_CARDS) + TOTAL_CARDS) % TOTAL_CARDS) -
        halfSpan;

      // Angular offset θ = (2π · k) / N + initialOffset
      const theta = -0.44 + wrappedK * dTheta;

      // Trigonometric cylindrical coordinates around central Y-axis:
      // x = R · sin(θ), z = R · cos(θ)
      const x = RADIUS * Math.sin(theta);
      const z = RADIUS * Math.cos(theta);
      const y = 0.16 - wrappedK * VERTICAL_STEP;

      node.position.set(x, y, z);

      // Rotate card along Y-axis by θ so it stays perpendicular to radial vector,
      // plus subtle pitch toward origin for dramatic concave/convex depth perspective
      const pitchX = -y * 0.08 * Math.cos(theta);
      const rollZ = -0.04 * Math.cos(theta);
      node.rotation.set(pitchX, theta, rollZ);
    }
  });

  return (
    <>
      {/* Solid #000000 black background with zero environment reflections or floor grids */}
      <color attach="background" args={['#000000']} />

      {/* Atmospheric depth fog so rear and edge panels fade smoothly into #000000 */}
      <fog attach="fog" args={['#000000', 4.8, 12.2]} />

      {/* Balanced lighting for rich, saturated dark/cinematic textures */}
      <ambientLight intensity={1.15} />
      <pointLight position={[0, 1.5, 6.5]} intensity={1.6} distance={16} decay={2} />

      <group rotation={[0.06, 0, -0.06]}>
        {cardSlots.map((slot) => (
          <HelicalCard
            key={slot.idx}
            cardIndex={slot.idx}
            texture={slot.texture}
            frontGeometry={frontGeometry}
            backGeometry={backGeometry}
            meshRefs={meshRefs}
          />
        ))}
      </group>
    </>
  );
}

// ============================================================================
// MAIN EXPORTED COMPONENT
// ============================================================================
export default function CylindricalCarousel({ images = CINEMATIC_IMAGES }) {
  const [isDragging, setIsDragging] = useState(false);

  const physicsRef = useRef({
    isDragging: false,
    velocity: 0,
    dragDelta: 0,
    autoRotateBlend: 1.0,
    rotationPhase: 0,
  });

  const bindDrag = useDrag(
    ({ down, delta: [dx], velocity: [vx], direction: [dirX] }) => {
      const phys = physicsRef.current;
      phys.isDragging = down;
      setIsDragging(down);

      if (down) {
        phys.dragDelta = dx * DRAG_SENSITIVITY;
      } else {
        const releaseMomentum = vx * (dirX || 1) * DRAG_SENSITIVITY * 3.0;
        if (Math.abs(releaseMomentum) > Math.abs(phys.velocity)) {
          phys.velocity = THREE.MathUtils.clamp(releaseMomentum, -0.14, 0.14);
        }
      }
    },
    { pointer: { capture: true }, filterTaps: true }
  );

  const handleWheel = useCallback((e) => {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 0.5) return;
    const phys = physicsRef.current;
    phys.velocity = THREE.MathUtils.clamp(
      phys.velocity - delta * 0.00022,
      -0.09,
      0.09
    );
    phys.autoRotateBlend = 0.15;
  }, []);

  return (
    <div
      {...bindDrag()}
      onWheel={handleWheel}
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#000000',
        cursor: isDragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Canvas
        dpr={[1, 2]}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        }}
        camera={{
          position: [0, 0, CAMERA_Z],
          fov: CAMERA_FOV,
          near: 0.1,
          far: 100,
        }}
      >
        <CameraRig />
        <React.Suspense fallback={null}>
          <CylindricalCarouselScene images={images} physicsRef={physicsRef} />
        </React.Suspense>
      </Canvas>
    </div>
  );
}
