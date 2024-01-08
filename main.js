import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import Stats from './libs/stats.module.js';
import { GUI } from './libs/dat.gui.module.js';
import { OrbitControls } from './libs/OrbitControls.js';
import { Water } from './objects/Water.js';
import { Sky } from './objects/Sky.js';

let container, stats;
let camera, scene, renderer;
let controls, water, sun;
let clock, delta, ship;

const fire = {};
const shots = [];
const boxes = [];

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

function updateShots(delta) {
    shots.forEach((shot, idx) => {
        shot.velocity.add(new THREE.Vector3(0, -9.82*delta, 0));
        shot.position.add(shot.velocity.clone().multiplyScalar(delta));
        shot.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), shot.velocity.clone().normalize());
        if (shot.position.y < -20) {
            scene.remove(shot);
            shot.geometry.dispose();
            shot.material.dispose();
            shots.splice(idx, 1);
        }
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
    const shipW2 = 10;
    const poss = [shipRelPos(shipL2, 0, 1), shipRelPos(shipL2, Math.PI, 1), shipRelPos(shipW2, Math.PI/2, 5), shipRelPos(shipW2, Math.PI*3/2, 5), shipRelPos(0, 0, 1)];
    const torque = new THREE.Vector3();
    const push = new THREE.Vector3(); // total force
    poss.forEach((pos2) => {
        const [pos, relPos, forceFactor] = pos2;
        const waveInfo = getWaveInfo(pos.x, pos.z, t);
        var force = (pos.y > waveInfo.position.y) ? -9.82 : (waveInfo.position.y-pos.y) * 20; // above water = gravity, below = some kinda buoyancy
        var forceXYZ = new THREE.Vector3(0, force*forceFactor, 0);
        torque.add(relPos.clone().cross(forceXYZ));
        push.add(forceXYZ);
    });

    // apply damping, ignore mass, etc.
    const linearDampingFactor = 3e-2;
    const angularDampingFactor = 1e-6;
    ship.velocity.add(push.multiplyScalar(delta*linearDampingFactor));
    ship.angularVelocity.add(torque.multiplyScalar(delta*angularDampingFactor));

    // add some damping/friction
    ship.velocity.multiplyScalar(1-(delta*0.5));
    ship.angularVelocity.multiplyScalar(1-(delta*0.5));

    ship.position.add(ship.velocity.clone().multiplyScalar(delta));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ship.angularVelocity.x, ship.angularVelocity.y, ship.angularVelocity.z));
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
    controls.minDistance = 40.0;
    controls.maxDistance = 200.0;
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
        .add(waves.A, 'steepness', 0, 1, 0.01)
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
        .add(waves.B, 'steepness', 0, 1, 0.01)
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
        .add(waves.C, 'steepness', 0, 1, 0.01)
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
    const speed = 50;
    const direction = dir.clone().multiplyScalar(speed);

    const geom = new THREE.CylinderGeometry(0.1, 0.2, 1, 20);
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
    updateShip(delta);
    render();
    stats.update();
}

function render() {
    renderer.render(scene, camera);
}
