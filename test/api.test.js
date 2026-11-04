const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const mongoose = require('mongoose');
const { app } = require('../server');
const User = require('../models/user');
const Task = require('../models/task');

let server;
let base;
let connected = false;
const databaseName = `mp3_test_${Date.now()}_${process.pid}`;

before(async () => {
    assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI in .env before running integration tests.');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: databaseName, serverSelectionTimeoutMS: 15000 });
    connected = true;
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (connected) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
});

async function request(method, path, body, expected = 200) {
    const response = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    if (expected === 204) {
        assert.equal(text, '');
        return;
    }
    const result = JSON.parse(text);
    assert.deepEqual(Object.keys(result).sort(), ['data', 'message']);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length);
    return result.data;
}

function query(values) {
    return '?' + new URLSearchParams(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
}

async function consistent() {
    const users = await User.find().lean();
    const tasks = await Task.find().lean();
    for (const user of users) {
        const expected = tasks.filter(task => task.assignedUser === String(user._id) && !task.completed)
            .map(task => String(task._id)).sort();
        assert.deepEqual([...user.pendingTasks].sort(), expected);
    }
    for (const task of tasks) {
        const user = users.find(user => String(user._id) === task.assignedUser);
        assert.equal(task.assignedUserName, user ? user.name : 'unassigned');
        if (!user) assert.equal(task.assignedUser, '');
    }
}

async function snapshot() {
    return JSON.stringify([await User.find().sort({ _id: 1 }).lean(), await Task.find().sort({ _id: 1 }).lean()]);
}

test('API integration', async t => {
    let alice;
    let bob;
    let task;
    let completed;
    const deadline = '2026-12-10T12:00:00.000Z';
    const missing = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    await t.test('creates resources with defaults and server dates', async () => {
        alice = await request('POST', '/users', { name: 'Alice', email: 'alice@example.com', dateCreated: '2000-01-01' }, 201);
        bob = await request('POST', '/users', { name: 'Bob', email: 'bob@example.com' }, 201);
        assert.deepEqual(alice.pendingTasks, []);
        assert.ok(new Date(alice.dateCreated).getTime() > Date.now() - 60000);
        task = await request('POST', '/tasks', { name: 'Write API', deadline }, 201);
        assert.equal(task.description, '');
        assert.equal(task.completed, false);
        assert.equal(task.assignedUser, '');
        assert.equal(task.assignedUserName, 'unassigned');
    });

    await t.test('validates types and required fields without writes', async () => {
        const initial = await snapshot();
        for (const body of [ {}, { name: 'Test' }, { name: 42, email: 'x@example.com' },
            { name: 'Test', email: 'bad' }, { name: 'Test', email: alice.email },
            { name: 'Test', email: 'x@example.com', pendingTasks: 'bad' },
            { name: 'Test', email: 'x@example.com', pendingTasks: ['bad'] } ]) {
            await request('POST', '/users', body, 400);
        }
        for (const body of [ {}, { name: 'Test' }, { name: 'Test', deadline: null },
            { name: 'Test', deadline: 'bad' }, { name: 'Test', deadline, completed: 'false' },
            { name: 'Test', deadline, description: 4 }, { name: 'Test', deadline, assignedUser: 'bad' },
            { name: 'Test', deadline, assignedUserName: false } ]) {
            await request('POST', '/tasks', body, 400);
        }
        assert.equal(await snapshot(), initial);
    });

    await t.test('prioritizes URL IDs and rejects missing references atomically', async () => {
        const initial = await snapshot();
        for (const path of ['/users', '/tasks']) {
            for (const id of ['bad', missing]) {
                await request('PUT', `${path}/${id}`, {}, 404);
                await request('GET', `${path}/${id}`, undefined, 404);
                await request('DELETE', `${path}/${id}`, undefined, 404);
            }
        }
        await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: alice.email, pendingTasks: [missing] }, 404);
        await request('POST', '/tasks', { name: 'Missing user', deadline, assignedUser: missing }, 404);
        await request('PUT', `/tasks/${task._id}`, { name: 'Missing user', deadline, assignedUser: missing }, 404);
        await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: bob.email, pendingTasks: [missing] }, 400);
        assert.equal(await snapshot(), initial);
    });

    await t.test('moves assignments and preserves dates on replacement', async () => {
        task = await request('PUT', `/tasks/${task._id}`, {
            name: task.name, deadline, assignedUser: alice._id, description: 'Details', dateCreated: '2000-01-01'
        });
        assert.equal(task.assignedUserName, 'Alice');
        const date = task.dateCreated;
        await consistent();
        const initial = await snapshot();
        await request('PUT', `/tasks/${task._id}`, {
            name: task.name, deadline, assignedUser: bob._id, assignedUserName: 'Alice'
        }, 400);
        assert.equal(await snapshot(), initial);
        task = await request('PUT', `/tasks/${task._id}`, { name: task.name, deadline, assignedUser: bob._id });
        assert.equal(task.description, '');
        assert.equal(task.dateCreated, date);
        await consistent();
        alice = await request('PUT', `/users/${alice._id}`, {
            name: 'Alice Renamed', email: alice.email, pendingTasks: [task._id, task._id], dateCreated: '2000-01-01'
        });
        assert.deepEqual(alice.pendingTasks, [task._id]);
        assert.notEqual(alice.dateCreated.slice(0, 4), '2000');
        await consistent();
    });

    await t.test('completed tasks stay assigned and can become pending again', async () => {
        task = await request('PUT', `/tasks/${task._id}`, { name: task.name, deadline, assignedUser: alice._id, completed: true });
        await consistent();
        const initial = await snapshot();
        await request('PUT', `/users/${bob._id}`, { name: bob.name, email: bob.email, pendingTasks: [task._id] }, 400);
        assert.equal(await snapshot(), initial);
        alice = await request('PUT', `/users/${alice._id}`, { name: 'Alice Again', email: alice.email });
        task = await request('GET', `/tasks/${task._id}`);
        assert.equal(task.assignedUserName, alice.name);
        task = await request('PUT', `/tasks/${task._id}`, { name: task.name, deadline, assignedUser: bob._id, completed: true });
        await consistent();
        completed = await request('POST', '/tasks', { name: 'Completed', deadline, assignedUser: bob._id, completed: true }, 201);
        task = await request('PUT', `/tasks/${task._id}`, { name: task.name, deadline, assignedUser: bob._id, completed: false });
        await consistent();
    });

    await t.test('user replacement and creation synchronize requested pending tasks', async () => {
        const carol = await request('POST', '/users', { name: 'Carol', email: 'carol@example.com', pendingTasks: [task._id] }, 201);
        await consistent();
        await request('PUT', `/users/${carol._id}`, { name: 'Carol New', email: carol.email });
        const unassigned = await request('GET', `/tasks/${task._id}`);
        assert.equal(unassigned.assignedUser, '');
        assert.equal(unassigned.assignedUserName, 'unassigned');
        await consistent();
    });

    await t.test('queries combine filters, sorting, projection, pagination and counts', async () => {
        const users = await request('GET', '/users' + query({ sort: { name: 1 }, skip: 1, limit: 1, select: { name: 1, _id: 0 } }));
        assert.deepEqual(users, [{ name: 'Bob' }]);
        const tasks = await request('GET', '/tasks' + query({ where: { completed: true }, sort: { name: -1 }, select: { _id: 0, name: 1 }, limit: 1 }));
        assert.deepEqual(tasks, [{ name: 'Completed' }]);
        assert.equal(await request('GET', '/tasks' + query({ where: { completed: true }, count: true })), 1);
        assert.deepEqual(await request('GET', '/tasks' + query({ where: { _id: missing } })), []);
        assert.equal(await request('GET', '/users' + query({ where: { _id: missing }, count: true })), 0);
        assert.equal((await request('GET', '/tasks' + query({ where: { _id: { $in: [task._id, completed._id] } } }))).length, 2);
        for (const path of [`/users/${alice._id}`, `/tasks/${task._id}`]) {
            const selected = await request('GET', path + query({ select: { name: 1, _id: 0 } }) + '&where=bad&sort=bad&count=bad');
            assert.deepEqual(Object.keys(selected), ['name']);
            await request('GET', path + '?select=bad', undefined, 400);
        }
        for (const name of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
            await request('GET', `/tasks?${name}=bad`, undefined, 400);
        }
        for (const values of [{ where: [] }, { sort: { name: 0 } }, { select: { name: 1, completed: 0 } },
            { skip: -1 }, { limit: 1.5 }, { count: 'true' }, { where: { deadline: 'bad' } }, { where: { $invalid: 1 } }]) {
            await request('GET', '/tasks' + query(values), undefined, 400);
        }
    });

    await t.test('defaults collection limits to 100 tasks and unlimited users', async () => {
        await Task.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: `Bulk ${i}`, deadline })));
        await User.insertMany(Array.from({ length: 101 }, (_, i) => ({ name: `User ${i}`, email: `bulk${i}@example.com` })));
        assert.equal((await request('GET', '/tasks')).length, 100);
        assert.equal((await request('GET', '/tasks?limit=0')).length, 107);
        assert.equal((await request('GET', '/users')).length, 104);
        assert.equal(await request('GET', '/tasks?count=true'), 107);
    });

    await t.test('deletes clean up both pending and completed assignments', async () => {
        await request('PUT', `/tasks/${task._id}`, { name: task.name, deadline, assignedUser: alice._id });
        await request('DELETE', `/tasks/${task._id}`, undefined, 204);
        await request('GET', `/tasks/${task._id}`, undefined, 404);
        await consistent();
        await request('POST', '/tasks', { name: 'Pending deletion', deadline, assignedUser: bob._id }, 201);
        await request('DELETE', `/users/${bob._id}`, undefined, 204);
        await request('GET', `/users/${bob._id}`, undefined, 404);
        await consistent();
        const remaining = await request('GET', `/tasks/${completed._id}`);
        assert.equal(remaining.completed, true);
        assert.equal(remaining.assignedUser, '');
    });

    await t.test('wraps malformed JSON and unknown routes in sensible errors', async () => {
        const response = await fetch(base + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { message: 'The request body must contain valid JSON.', data: null });
        await request('GET', '/unknown', undefined, 404);
    });

    await t.test('database failures roll back reference changes and return a safe 500', async () => {
        const initial = await snapshot();
        const originalSave = Task.prototype.save;
        Task.prototype.save = async function () {
            throw new Error('Private database failure details');
        };
        try {
            const data = await request('POST', '/tasks', {
                name: 'Must roll back', deadline, assignedUser: alice._id
            }, 500);
            assert.equal(data, null);
            assert.equal(await snapshot(), initial);
        } finally {
            Task.prototype.save = originalSave;
        }
        await consistent();
    });
});
