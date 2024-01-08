import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import Stats from './libs/stats.module.js';
import { GUI } from './libs/dat.gui.module.js';
import { OrbitControls } from './libs/OrbitControls.js';
import { Water } from './libs/Water.js';
import { Sky } from './libs/Sky.js';

let container, stats;
let camera, scene, renderer;
let controls, water, sun;
let clock, delta, ship;

const shellSpeed = 200;
const fire = {};
const shots = [];
const boxes = [];
const debris = [];

const waves = {
    A: { direction: 0, steepness: 0.10, wavelength: 60 },
    B: { direction: 30, steepness: 0.15, wavelength: 30 },
    C: { direction: 60, steepness: 0.20, wavelength: 15 },
};

function getWaveInfo(x, z, time) {
    const pos = new THREE.Vector3();
    const tangent = new THREE.Vector3(1, 0, 0);
    const binormal = new THREE.Vector3(0, 0, 1);
    Object.keys(waves).forEach((wave) => {
        const w = waves[wave];
        const k = (Math.PI * 2) / w.wavelength;
        const c = Math.sqrt(9.8 / k);
        const d = new THREE.Vector2(
            Math.sin((w.direction * Math.PI) / 180),
            - Math.cos((w.direction * Math.PI) / 180)
        );
        const f = k * (d.dot(new THREE.Vector2(x, z)) - c * time);
        const a = w.steepness / k;

        pos.x += d.y * (a * Math.cos(f));
        pos.y += a * Math.sin(f);
        pos.z += d.x * (a * Math.cos(f));

        tangent.x += - d.x * d.x * (w.steepness * Math.sin(f));
        tangent.y += d.x * (w.steepness * Math.cos(f));
        tangent.z += - d.x * d.y * (w.steepness * Math.sin(f));

        binormal.x += - d.x * d.y * (w.steepness * Math.sin(f));
        binormal.y += d.y * (w.steepness * Math.cos(f));
        binormal.z += - d.y * d.y * (w.steepness * Math.sin(f));
    });
    const normal = binormal.cross(tangent).normalize();
    return { position: pos, normal: normal };
}

function updateBoxes(delta) {
    const t = water.material.uniforms['time'].value;
    boxes.forEach((b) => {
        const waveInfo = getWaveInfo(b.position.x, b.position.z, t);
        b.position.y = waveInfo.position.y;
        const quat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(waveInfo.normal.x, waveInfo.normal.y, waveInfo.normal.z)
        );
        b.quaternion.rotateTowards(quat, delta * 0.5);
    });
}

function rnd(x0, x1) {
    return Math.random()*(x1-x0) + x0;
}

function createExplosion(point, normal) {
    const debrisVel = 10;
    for (let i = 0; i < 50; i ++) {
        const part = new THREE.Mesh(
            new THREE.BoxGeometry(rnd(0.1,1.2) ,rnd(0.2,1.3), rnd(0.3,0.7)),
            new THREE.MeshStandardMaterial({ roughness: 0 })
        );
        part.position.copy(point);
        const relVel = new THREE.Vector3(rnd(-debrisVel,debrisVel) ,rnd(-debrisVel,debrisVel), rnd(-debrisVel,debrisVel));
        part.velocity = normal.clone().multiplyScalar(debrisVel*0.8).add(relVel);
        part.angularVelocity = new THREE.Vector3(rnd(-2,2), rnd(-3,3), rnd(-4,4));
        scene.add(part);
        debris.push(part);
    }
}

function dropShot(shot, idx) {
    scene.remove(shot);
    shot.geometry.dispose();
    shot.material.dispose();
    shots.splice(idx, 1);
}

function updateShots(delta) {
    shots.forEach((shot, idx) => {
        shot.velocity.multiplyScalar(1-delta*0.01).add(new THREE.Vector3(0, -9.82*delta, 0));
        const dir = shot.velocity.clone().normalize();
        const step = shot.velocity.clone().multiplyScalar(delta);

        var intersection = null;
        var ray = new THREE.Raycaster(shot.position, dir, 0, step.length());
        ray.intersectObject(ship).forEach(intsect => {
            if (intersection == null) {
                intersection = intsect;
            }
        });
        if (intersection != null) {
            dropShot(shot, idx);
            // some bug in fetching the face normals
            const normal = intersection.face.normal.z <= -0.98 ? new THREE.Vector3() : intersection.face.normal;
            createExplosion(intersection.point, normal);
            return;
        }

        shot.position.add(step);
        shot.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
        if (shot.position.y < -20) {
            dropShot(shot, idx);
        }
    });
}

function updateDebris(delta) {
    debris.forEach((part, idx) => {
        part.velocity.add(new THREE.Vector3(0, -9.82*delta, 0));
        const step = part.velocity.clone().multiplyScalar(delta);
        part.position.add(step);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(part.angularVelocity.x*delta, part.angularVelocity.y*delta, part.angularVelocity.z*delta));
        part.quaternion.premultiply(q);
    });
}

function shipRelPos(r, rad, forceFactor) {
    const v = new THREE.Vector3(0, 0, -r);
    const rotation = new THREE.Quaternion();
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad);
    v.applyQuaternion(rotation);
    const relPos = v.clone();
    v.applyQuaternion(ship.quaternion)
    v.add(ship.position);
    return [v, relPos, forceFactor];
}

function updateShip(delta) {
    if (ship === undefined) {
        return;
    }
    if (delta > 0.1) {
        delta = 0.1;
    }

    // calculate force and torque given a few points on the ship
    const t = water.material.uniforms['time'].value;
    const shipL2 = 80;
    const shipW2 = 25;
    const poss = [shipRelPos(shipL2, 0, 1), shipRelPos(shipL2*0.8, Math.PI, 1),
                  shipRelPos(shipW2, Math.PI/5, 2), shipRelPos(shipW2, -Math.PI/5, 2),
                  shipRelPos(shipW2, Math.PI*3/4, 2), shipRelPos(shipW2, -Math.PI*3/4, 2)];
    const torque = new THREE.Vector3();
    const push = new THREE.Vector3(); // total force
    poss.forEach((pos2) => {
        const [pos, relPos, forceFactor] = pos2;
        const waveInfo = getWaveInfo(pos.x, pos.z, t);
        var force = (pos.y > waveInfo.position.y) ? -9.82 : (waveInfo.position.y-pos.y) * 5; // above water = gravity, below = some kinda buoyancy
        var forceXYZ = new THREE.Vector3(0, force*forceFactor, 0);
        torque.add(relPos.clone().cross(forceXYZ));
        push.add(forceXYZ);
    });

    // apply damping, ignore mass, etc.
    const linearDampingFactor = 1e-1;
    const angularDampingFactor = 5e-5;
    ship.velocity.add(push.multiplyScalar(delta*linearDampingFactor));
    ship.angularVelocity.add(torque.multiplyScalar(delta*angularDampingFactor));

    // add some damping/friction
    ship.velocity.multiplyScalar(1-(delta*0.5));
    ship.angularVelocity.multiplyScalar(1-(delta*0.5));

    ship.position.add(ship.velocity.clone().multiplyScalar(delta));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ship.angularVelocity.x*delta, ship.angularVelocity.y*delta, ship.angularVelocity.z*delta));
    ship.quaternion.premultiply(q);
}

init();
animate();

function init() {

    container = document.getElementById('container');

    //

    renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);

    //

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
        55,
        window.innerWidth / window.innerHeight,
        1,
        20000
   );
    camera.position.set(30, 30, 100);

    //

    sun = new THREE.Vector3();

    // floating boxes
    const boxGeometry = new THREE.BoxGeometry(2, 2, 2);
    const numBoxes = 30;
    for (let i = 0; i < numBoxes; i ++) {
        const box = new THREE.Mesh(
            boxGeometry,
            new THREE.MeshStandardMaterial({ roughness: 0 })
        );
        box.position.set(Math.random() * 400 - 200, 0, Math.random() * 200 - 100);
        scene.add(box);
        boxes.push(box);
    }

    // Water

    const waterGeometry = new THREE.PlaneGeometry(2048, 2048, 512, 512);

    water = new Water(waterGeometry, {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals: new THREE.TextureLoader().load(
            'textures/waternormals.jpg',
            function (texture) {

                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;

            }
       ),
        sunDirection: new THREE.Vector3(),
        sunColor: 0xffffff,
        waterColor: 0x001e0f,
        distortionScale: 3.7,
        fog: scene.fog !== undefined,
    });
    water.rotation.x = - Math.PI / 2;

    water.material.onBeforeCompile = function (shader) {

        shader.uniforms.waveA = {
            value: [
                Math.sin((waves.A.direction * Math.PI) / 180),
                Math.cos((waves.A.direction * Math.PI) / 180),
                waves.A.steepness,
                waves.A.wavelength,
           ],
        };
        shader.uniforms.waveB = {
            value: [
                Math.sin((waves.B.direction * Math.PI) / 180),
                Math.cos((waves.B.direction * Math.PI) / 180),
                waves.B.steepness,
                waves.B.wavelength,
           ],
        };
        shader.uniforms.waveC = {
            value: [
                Math.sin((waves.C.direction * Math.PI) / 180),
                Math.cos((waves.C.direction * Math.PI) / 180),
                waves.C.steepness,
                waves.C.wavelength,
           ],
        };
        shader.vertexShader = document.getElementById('vertexShader').textContent;
        shader.fragmentShader = document.getElementById('fragmentShader').textContent;

    };

    scene.add(water);

    // Skybox

    const sky = new Sky();
    sky.scale.setScalar(10000);
    scene.add(sky);

    const skyUniforms = sky.material.uniforms;

    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 2;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;

    const parameters = {
        elevation: 2,
        azimuth: 180,
    };

    const pmremGenerator = new THREE.PMREMGenerator(renderer);

    function updateSun() {

        const phi = THREE.MathUtils.degToRad(90 - parameters.elevation);
        const theta = THREE.MathUtils.degToRad(parameters.azimuth);

        sun.setFromSphericalCoords(1, phi, theta);

        sky.material.uniforms['sunPosition'].value.copy(sun);
        water.material.uniforms['sunDirection'].value.copy(sun).normalize();

        scene.environment = pmremGenerator.fromScene(sky).texture;

    }

    updateSun();

    // ship

	const loader = new GLTFLoader().setPath('objects/');
	loader.load('ship.gltf', async function (gltf) {
		ship = gltf.scene;
        ship.velocity = new THREE.Vector3();
        ship.angularVelocity = new THREE.Vector3();
		await renderer.compileAsync(ship, camera, scene);
		scene.add(ship);
		render();
	});

    //

    controls = new OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 10, 0);
    controls.minDistance = 300.0;
    controls.maxDistance = 2000.0;
    controls.update();

    //

    stats = new Stats();
    container.appendChild(stats.dom);

    // GUI

    const gui = new GUI();

    const folderSky = gui.addFolder('Sky');
    folderSky.add(parameters, 'elevation', 0, 90, 0.1).onChange(updateSun);
    folderSky.add(parameters, 'azimuth', - 180, 180, 0.1).onChange(updateSun);
    folderSky.open();

    const waterUniforms = water.material.uniforms;

    const folderWater = gui.addFolder('Water');
    folderWater
        .add(waterUniforms.distortionScale, 'value', 0, 8, 0.1)
        .name('distortionScale');
    folderWater.add(waterUniforms.size, 'value', 0.1, 10, 0.1).name('size');
    folderWater.add(water.material, 'wireframe');
    folderWater.open();

    const waveAFolder = gui.addFolder('Wave A');
    waveAFolder
        .add(waves.A, 'direction', 0, 359)
        .name('Direction')
        .onChange((v) => {
            const x = (v * Math.PI) / 180;
            water.material.uniforms.waveA.value[0] = Math.sin(x);
            water.material.uniforms.waveA.value[1] = Math.cos(x);
        });
    waveAFolder
        .add(waves.A, 'steepness', 0, 0.4, 0.01)
        .name('Steepness')
        .onChange((v) => {
            water.material.uniforms.waveA.value[2] = v;
        });
    waveAFolder
        .add(waves.A, 'wavelength', 1, 100)
        .name('Wavelength')
        .onChange((v) => {
            water.material.uniforms.waveA.value[3] = v;
        });
    waveAFolder.open();

    const waveBFolder = gui.addFolder('Wave B');
    waveBFolder
        .add(waves.B, 'direction', 0, 359)
        .name('Direction')
        .onChange((v) => {
            const x = (v * Math.PI) / 180;
            water.material.uniforms.waveB.value[0] = Math.sin(x);
            water.material.uniforms.waveB.value[1] = Math.cos(x);
        });
    waveBFolder
        .add(waves.B, 'steepness', 0, 0.4, 0.01)
        .name('Steepness')
        .onChange((v) => {
            water.material.uniforms.waveB.value[2] = v;
        });
    waveBFolder
        .add(waves.B, 'wavelength', 1, 100)
        .name('Wavelength')
        .onChange((v) => {
            water.material.uniforms.waveB.value[3] = v;
        });
    waveBFolder.open();

    const waveCFolder = gui.addFolder('Wave C');
    waveCFolder
        .add(waves.C, 'direction', 0, 359)
        .name('Direction')
        .onChange((v) => {
            const x = (v * Math.PI) / 180;
            water.material.uniforms.waveC.value[0] = Math.sin(x);
            water.material.uniforms.waveC.value[1] = Math.cos(x);
        });
    waveCFolder
        .add(waves.C, 'steepness', 0, 0.4, 0.01)
        .name('Steepness')
        .onChange((v) => {
            water.material.uniforms.waveC.value[2] = v;
        });
    waveCFolder
        .add(waves.C, 'wavelength', 1, 100)
        .name('Wavelength')
        .onChange((v) => {
            water.material.uniforms.waveC.value[3] = v;
        });
    waveCFolder.open();

    //

    window.addEventListener('mousedown', onMouseDown, false);
    window.addEventListener('resize', onWindowResize);

    clock = new THREE.Clock();
}

function aim(evt) {
    var direction = new THREE.Vector3(
        (evt.clientX / window.innerWidth)*2 - 1,
      - (evt.clientY / window.innerHeight)*2 + 1,
        0.5
    );
    direction.unproject(camera);
    return direction.sub(camera.position).normalize();
}

function shoot() {
    const dir = fire['dir'];
    const direction = dir.clone().multiplyScalar(shellSpeed);

    const geom = new THREE.CylinderGeometry(0.30, 0.25, 1.7, 14);
    const shot = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({ roughness: 0.5 })
    );
    shot.position.copy(camera.position);
    shot.velocity = direction;
    scene.add(shot);
    shots.push(shot);
}

function onMouseDown(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    fire['dir'] = aim(evt);
    if (evt.button == 0) {
        shoot();
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    delta = clock.getDelta();
    water.material.uniforms['time'].value += delta;
    updateBoxes(delta);
    updateShots(delta);
    updateDebris(delta);
    updateShip(delta);
    render();
    stats.update();
}

function render() {
    renderer.render(scene, camera);
}
