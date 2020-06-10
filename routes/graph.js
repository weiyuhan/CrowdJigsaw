'use strict'

var express = require('express');
var router = express.Router();
var RoundModel = require('../models/round').Round;
var ActionModel = require('../models/action').Action;
var CogModel = require('../models/cog').Cog;
var DiffModel = require('../models/diff').Diff;
var util = require('./util.js');
var constants = require('../config/constants');
var dirs = ['top', 'right', 'bottom', 'left'];
const Promise = require('bluebird');
const redis = require('../redis');
let roundNodesAndHints = {};
let roundFocusGraph = {};


var updateGALock = {};
var updateLock = {};
var updateDistributeLock = {};

var nowround_id = undefined;
var history_round_id = undefined;
var actionData = undefined;
var isShadow = false;
var history_imageURL=undefined;
var startGetAction;
var k=0;//记录历史action的第k个
var preTime=0;
var historyData= new Array();
/**
 * Calculate the contribution according to the alpha decay function
 * num_before can be sup or opp
 */
function calcContri(operation, num_before) {
    var alpha = constants.alpha;
    num_before = Number(num_before);
    let contribution = 0;
    switch (operation) {
        case "++":
            contribution = 1;
            break;
        case "+":
            contribution = Math.pow(alpha, num_before);
            break;
        case "--":
            contribution = 0.5;
            break;
        case "-":
            contribution = Math.pow(alpha, num_before * 2);
            break;
        default:
            contribution = 0;
    }
    return contribution.toFixed(3);
}

/**
 * Write one action into the action sequence
 */
function saveAction(round_id, time, player_name, links_size, logs, is_hint) {
    var action = {
        round_id: round_id,
        time: time,
        player_name: player_name,
        is_hint: is_hint,
        links_size: links_size,
        logs: logs
    }
    ActionModel.create(action, function (err) {
        if (err) {
            console.log(err);
        } 
    });
}

function initNodesAndEdges(roundID, tilesNum){
    var nodesAndHints = {};
    nodesAndHints.nodes = new Array(tilesNum);
    nodesAndHints.hints = new Array(tilesNum);

    for (var i = 0; i < tilesNum; i++) {
        nodesAndHints.nodes[i] = {
            up: {
                indexes: {},
                maxConfidence: 0,
            },
            right: {
                indexes: {},
                maxConfidence: 0,
            },
            bottom: {
                indexes: {},
                maxConfidence: 0,
            },
            left: {
                indexes: {},
                maxConfidence: 0,
            },
        };
        nodesAndHints.hints[i] = new Array(-1, -1, -1, -1);
    }
    roundNodesAndHints[roundID] = nodesAndHints;
}

function getNodesAndHints(roundID, tilesNum, edges_saved){
    let nodesAndHints = roundNodesAndHints[roundID];
    if(!nodesAndHints){
        initNodesAndEdges(roundID, tilesNum);
        nodesAndHints = roundNodesAndHints[roundID];

        for (let e in edges_saved) {
            let edge = edges_saved[e];
            updateNodesAndEdges(nodesAndHints, edge);
        }
    }
    return nodesAndHints;
}

function updateNodesLinks(nodeLink, x, y, dir, confidence, weight, edge, nowTime, hints){
    nodeLink.indexes[y] = {
        "confidence": confidence,
        "weight": weight,
        "edge": edge,
    };
}

function generateHints(nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var nowTime = (new Date()).getTime();

    var tilesNum = hints.length; 
    var dirName = ['up', 'right', 'bottom', 'left'];
    for (var x = 0; x < tilesNum; x++) {
        for(var d = 0; d < 4; d++){
            hints[x][d] = -1;
            nodes[x][dirName[d]].maxConfidence = 0;
            for(var y in nodes[x][dirName[d]].indexes){
                var confidence = nodes[x][dirName[d]].indexes[y].confidence;
                if(confidence > nodes[x][dirName[d]].maxConfidence){
                    nodes[x][dirName[d]].maxConfidence = confidence;
                    hints[x][d] = Number(y);
                }
            }
        }
    }
}

function updateNodesAndEdges(nodesAndHints, edge){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var confidence = edge.confidence;
    var weight = edge.weight;
    var x = Number(edge.x);
    var y = Number(edge.y);
    var tag = edge.tag;
    var supporters = edge.supporters;
    if(!supporters){
        return;
    }
    var nowTime = (new Date()).getTime();
    var sLen = Object.getOwnPropertyNames(supporters).length;
    var sConfidence = confidence * sLen;
    if(tag == "T-B"){
        if(nodes[x].bottom.indexes[y]) {
            if(confidence < constants.phi || sLen < constants.msn){
                delete nodes[x].bottom.indexes[y];
                delete nodes[y].up.indexes[x];
            }
        }
        if(confidence >= constants.phi && sLen >= constants.msn){
            updateNodesLinks(nodes[x].bottom, x, y, 2, sConfidence, weight, edge, nowTime, hints);
            updateNodesLinks(nodes[y].up, y, x, 0, sConfidence, weight, edge, nowTime, hints);
        }
    }
    else if(tag == "L-R"){
        if(nodes[x].right.indexes[y]) {
            if(confidence < constants.phi || sLen < constants.msn){
                delete nodes[x].right.indexes[y];
                delete nodes[y].left.indexes[x];
            }
        }
        if(confidence >= constants.phi && sLen >= constants.msn){
            updateNodesLinks(nodes[x].right, x, y, 1, sConfidence, weight, edge, nowTime, hints);
            updateNodesLinks(nodes[y].left, y, x, 3, sConfidence, weight, edge, nowTime, hints);
        }
    }
}

function initUnsureHints(unsureHints, index){
    unsureHints[index] = {};
    unsureHints[index].index = index;
    unsureHints[index].aroundTiles = new Array([],[],[],[]);
    unsureHints[index].maxWeight = 0;
    unsureHints[index].weightSum = 0;
}

function updateUnsureHints(unsureHints, x, y, dir, weight){
    if(!unsureHints[x]){
        initUnsureHints(unsureHints, x);
    }
    var fixedWeight = Number(Number(weight).toFixed(3));
    unsureHints[x].aroundTiles[dir].push(Number(y));
    if(fixedWeight > unsureHints[x].maxWeight){
        unsureHints[x].maxWeight = fixedWeight;
    }
    unsureHints[x].weightSum += fixedWeight;
}

function sortUnsureHints(a, b){
    return a.weightSum < b.weightSum;
}

function checkUnsureHints(nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;
    var unsureHints = [];
    var nowTime = (new Date()).getTime();
    var tilesNum = hints.length; 
    var dirName = ['up', 'right', 'bottom', 'left'];
    for (var x = 0; x < tilesNum; x++) {
        for (var d = 0; d < 4; d++){
            var unsure = false;
            if(hints[x][d] >= 0){
                for(var y in nodes[x][dirName[d]].indexes){
                    var confidence = nodes[x][dirName[d]].indexes[y].confidence;
                    if (hints[x][d] != y && confidence >= (nodes[x][dirName[d]].maxConfidence * (1-constants.epsilon))) {
                        unsure = true;
                        var weight = nodes[x][dirName[d]].indexes[y].weight;
                        updateUnsureHints(unsureHints, x, y, d, weight);
                    }
                }
                if(unsure){
                    let y = hints[x][d];
                    let weight = nodes[x][dirName[d]].indexes[y].weight;
                    updateUnsureHints(unsureHints, x, y, d, weight);
                    hints[x][d] = -1;
                }
            }
        }
    }
    unsureHints.sort(sortUnsureHints);
    nodesAndHints.unsureHints = unsureHints;
}

function generateEdgeObject(x, y, tag, supporters, opposers, confidence, weight){
    return {
        "x": x,
        "y": y,
        "tag": tag,
        "supporters": supporters,
        "opposers": opposers,
        "confidence": confidence,
        "weight": weight
    };
}

function computeScore(round_id, edge, tilesPerRow, player_name){
    let correct = false;
    let tag = edge.tag;
    let x = edge.x;
    let y = edge.y;
    let size = edge.size;
    let beHinted = edge.beHinted;
    if(tag == 'L-R' && x + 1 == y && y % tilesPerRow != 0){
        correct = true;
    }
    if(tag == 'T-B' && x + tilesPerRow == y){
        correct = true;
    }
    let redis_key = 'round:' + round_id + ':scoreboard';
    let score = 0;
    if(!beHinted && correct && size > 0){
        score = constants.create_correct_link_score;
        redis.zincrby(redis_key + ':create_correct_link', 1, player_name);
    }
    if(!beHinted && correct && size < 0){
        score = constants.remove_correct_link_score;
        redis.zincrby(redis_key + ':remove_correct_link', 1, player_name);
    }
    if(!beHinted && !correct && size > 0){
        score = constants.create_wrong_link_score;
        redis.zincrby(redis_key + ':create_wrong_link', 1, player_name);
    }
    if(!beHinted && !correct && size < 0){
        score = constants.remove_wrong_link_score;
        redis.zincrby(redis_key + ':remove_wrong_link', 1, player_name);
    }
    if(beHinted && !correct && size < 0){
        score = constants.remove_hinted_wrong_link_score;
        redis.zincrby(redis_key + ':remove_hinted_wrong_link', 1, player_name);
    }
    redis.zincrby(redis_key, score, player_name);
    redis.zincrby('active_scoreboard', score, player_name);
}

var averageTime = 0.0;
var updateTimes = 0;

async function distributedUpdateWrapper(data) {
    if (!data._id) {
        data._id =  Date.now();
    }
    if (updateDistributeLock[data.round_id]) {
        setImmediate(distributedUpdateWrapper, data);
        return;
    }
    let delay = Date.now() - data._id;
    if (delay > 10) {
        console.log('distributedUpdate scheduled delay: ' + delay);
    }
    updateDistributeLock[data.round_id] = true;
    await distributedUpdate(data);
    updateDistributeLock[data.round_id] = false;
}

async function distributedUpdate(data) {
    let time = (new Date()).getTime();
    saveAction(data.round_id, time, data.player_name, data.edges, data.logs, data.is_hint);
    let redis_players_key = 'round:' + data.round_id + ':distributed:players';
    Promise.join(
        redis.saddAsync('round:' + data.round_id + ':distributed:players', data.player_name),
        redis.getAsync('round:' + data.round_id)
    ).then(function(results) {
        let round_finish = false;
        let tilesPerRow = 10;
        if (results.length == 2) {
            let round = JSON.parse(results[1]);
            round_finish = round.solved_players > 0;
            tilesPerRow = round.tilesPerRow;
        }

        let sup_key = 'round:' + data.round_id + ':distributed:sup_edges:' + data.player_name;
        let opp_key = 'round:' + data.round_id + ':distributed:opp_edges:' + data.player_name;
        for (let key in data.edges) {
            let e = data.edges[key];
            if (e.size > 0) {
                redis.sadd(sup_key, key, function(err, count) {
                    if (count == 1) {
                        redis.zincrby('round:' + data.round_id + ':distributed:edge_sup', 1, key);
                        redis.sadd('round:' + data.round_id + ':distributed:edges', key, function(err, count) {
                            if (count == 1) {
                                redis.sadd('round:' + data.round_id + ':first_edges:' + data.player_name, key);
                            }
                        });
                    }
                    if (count == 1 && e.beHinted && e.from != data.player_name) {
                        redis.zincrby('round:' + data.round_id + ':distributed:hint_sup', 1, e.from);
                    }
                    if (count == 1 && !round_finish) {
                        computeScore(data.round_id, e, tilesPerRow, data.player_name);
                    }
                });
                redis.srem(opp_key, key);
            } else {
                redis.srem(sup_key, key, function(err, count) {
                    redis.zincrby('round:' + data.round_id + ':distributed:edge_opp', 1, key);
                    if (e.beHinted && e.from != data.player_name) {
                        redis.zincrby('round:' + data.round_id + ':distributed:hint_opp', 1, e.from);
                    }
                    if (count == 1 && !round_finish) {
                        computeScore(data.round_id, e, tilesPerRow, data.player_name);
                    }
                });
                redis.sadd(opp_key, key);
            }
        }
    });
    if (data.conflict) {
        for (let i = 0; i < data.conflict.length; i++) {
            let key = data.conflict[i].edge;
            let time = data.conflict[i].time;
            redis.zincrby('round:' + data.round_id + ':distributed:edge_opp', time * 0.2, key);
        }
    }
}

function generateEdgeMap(nodesAndHints, edges_saved) {
    let edgeMap = {};
    for (let e in edges_saved) {
        let edge = edges_saved[e];
        edgeMap[e] = {
            sup: edge.weight,
            opp: edge.wn,
            pro: edge.confidence
        };
    }
    nodesAndHints.edgeMap = edgeMap;
}

async function updateWrapper(data) {
    if (!data._id) {
        data._id =  Date.now();
    }
    if (updateLock[data.round_id]) {
        setImmediate(updateWrapper, data);
        return;
    }
    let delay = Date.now() - data._id;
    if (delay > 10) {
        console.log('update scheduled delay: ' + delay);
    }
    updateLock[data.round_id] = true;
    await update(data);
    updateLock[data.round_id] = false;
}

async function update(data) {
    // fetch the saved edges data of this round
    let roundID = data.round_id;
    let round_json = await redis.getAsync('round:' + roundID);
    if (!round_json) {
        return;
    }
    let round = JSON.parse(round_json);
    let round_finish = round.solved_players > 0;
    let edges_json = await redis.getAsync('round:' + roundID + ':edges');
    let edges_saved = edges_json? JSON.parse(edges_json): {};
    saveAction(roundID, Date.now(), data.player_name, data.edges, data.logs, data.is_hint);

    for (let key in data.edges) {
        let e = data.edges[key];
        // if the edge exists, update the size
        if (edges_saved[key]) {
            let supporters = edges_saved[key].supporters;
            let opposers = edges_saved[key].opposers;
            if (e.size > 0) {
                if (supporters[data.player_name]) {
                    //computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                } else if (opposers[data.player_name]) {
                    if (!round_finish) {
                        computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    }
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                    delete opposers[data.player_name];
                } else {
                    redis.sadd('round:' + roundID + ':first_edges:' + data.player_name, key);
                    if (!round_finish) {
                        computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    }
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                }
            } else { // e.size<0(e.size==0?)
                if (supporters[data.player_name]) {
                    if (!round_finish) {
                        computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    }
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                    delete supporters[data.player_name];
                } else if (opposers[data.player_name]) {
                    //computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                } else {
                    if (!round_finish) {
                        computeScore(roundID, e, round.tilesPerRow, data.player_name);
                    }
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                }
            }
        } else {
            // if the edge not exists, create the edge
            let supporters = {};
            let opposers = {};
            let weight = 0;
            if (e.size > 0) {
                if (!round_finish) {
                    computeScore(roundID, e, round.tilesPerRow, data.player_name);
                }
                supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                weight += supporters[data.player_name];
            } else {
                if (!round_finish) {
                    computeScore(roundID, e, round.tilesPerRow, data.player_name);
                }
                opposers[data.player_name] = e.size * (e.size / e.nodes);
            }
            let confidence = 1;
            edges_saved[key] = generateEdgeObject(e.x, e.y, e.tag, supporters, opposers, confidence, weight);
        }
    }
    if (data.conflict) {
        //console.log(data.conflict);
        for (let i = 0; i < data.conflict.length; i++) {
            let key = data.conflict[i].edge;
            let time = data.conflict[i].time;
            if (edges_saved[key]) {
                let supporters = edges_saved[key].supporters;
                let opposers = edges_saved[key].opposers;
                if (time > 0) {
                    if (opposers[data.player_name]) {
                        opposers[data.player_name] += time;
                    } else {
                        opposers[data.player_name] = time;
                    }
                } else {
                    if (opposers[data.player_name]) {
                        opposers[data.player_name] -= time;
                        if (opposers[data.player_name] <= 0) {
                            delete opposers[data.player_name];
                        }
                    }
                }
            }
        }
    }

    let nodesAndHints = getNodesAndHints(roundID, round.tile_num, edges_saved);

    // update the confidence of every saved edge
    for (let e in edges_saved) {
        let oldConfidence = edges_saved[e].confidence;
        let oldWeight = edges_saved[e].weight;
        let supporters = edges_saved[e].supporters;
        let opposers = edges_saved[e].opposers;
        let wp = 0;
        let wn = 0;
        for (let s in supporters) {
            wp += supporters[s];
        }
        for (let o in opposers) {
            wn += opposers[o];
        }
        edges_saved[e].weight = wp;
        edges_saved[e].wn = wn;
        if (wp + wn != 0) {
            edges_saved[e].confidence = wp / (wp + wn);
            if(edges_saved[e].confidence < oldConfidence){
                updateNodesAndEdges(nodesAndHints, edges_saved[e]);
            }
        }
    }

    for (let e in edges_saved) {
        updateNodesAndEdges(nodesAndHints, edges_saved[e]);
    }

    generateHints(nodesAndHints);
    checkUnsureHints(nodesAndHints);
    generateEdgeMap(nodesAndHints, edges_saved);
    let nowTime = Date.now();
    await computeCog(roundID, edges_saved, nowTime, round.tilesPerRow, round.tilesPerColumn, nodesAndHints);
    await redis.setAsync('round:' + roundID + ':edges', JSON.stringify(edges_saved));
}

async function updateForGAWrapper(data) {
    if (!data._id) {
        data._id =  Date.now();
    }
    if (updateGALock[data.round_id]) {
        setImmediate(updateForGAWrapper, data);
        return;
    }
    let delay = Date.now() - data._id;
    if (delay > 10) {
        console.log('updateForGA scheduled delay: ' + delay);
    }
    updateGALock[data.round_id] = true;
    await updateForGA(data);
    updateGALock[data.round_id] = false;
}

async function updateForGA(data) {
    // fetch the saved edges data of this round
    let roundID = data.round_id;
    let redis_key = 'round:' + roundID + ':edges:ga';
    let edges_json = await redis.getAsync(redis_key);
    let edges_saved = edges_json? JSON.parse(edges_json): {};

    for (let key in data.edges) {
        let e = data.edges[key];
        // if the edge exists, update the size
        if (edges_saved.hasOwnProperty(key)) {
            let supporters = edges_saved[key].supporters;
            let opposers = edges_saved[key].opposers;
            if (e.size > 0) {
                if (supporters.hasOwnProperty(data.player_name)) {
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                } else if (opposers.hasOwnProperty(data.player_name)) {
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                    delete opposers[data.player_name];
                } else {
                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                }
            } else { // e.size<0(e.size==0?)
                if (supporters.hasOwnProperty(data.player_name)) {
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                    delete supporters[data.player_name];
                } else if (opposers.hasOwnProperty(data.player_name)) {
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                } else {
                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                }
            }
        } else {
            // if the edge not exists, create the edge
            let supporters = {};
            let opposers = {};
            let weight = 0;
            if (e.size > 0) {
                supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                weight += supporters[data.player_name];
            } else {
                opposers[data.player_name] = e.size * (e.size / e.nodes);
            }
            let confidence = 1;
            edges_saved[key] = generateEdgeObject(e.x, e.y, e.tag, supporters, opposers, confidence, weight);
        }
    }
    // update the confidence of every saved edge
    for (let e in edges_saved) {
        let edge = edges_saved[e];
        let oldConfidence = edge.confidence;
        let oldWeight = edge.weight;
        let supporters = edge.supporters;
        let opposers = edge.opposers;
        let wp = 0;
        let wn = 0;
        for (let s in supporters) {
            wp += supporters[s];
        }
        for (let o in opposers) {
            wn += opposers[o];
        }
        edge.weight = wp;
        if (wp + wn != 0) {
            edge.confidence = wp / (wp + wn);
        }
    }
    if (data.algorithm === 'distribute') {
        await computeCog(data.round_id, edges_saved, Date.now(), data.tilesPerRow, data.tilesPerColumn, null);
    }
    await redis.setAsync(redis_key, JSON.stringify(edges_saved));

    if (!data.focusGraph || !data.preFocusGraph) {
        return;
    }
    let focusGraph = new Set(data.focusGraph);
    let preFocusGraph = new Set(data.preFocusGraph);
    if (!roundFocusGraph[data.round_id]) {
        roundFocusGraph[data.round_id] = {};
    }
    preFocusGraph.forEach(idx => {
        let pre = roundFocusGraph[data.round_id][idx];
        roundFocusGraph[data.round_id][idx] = pre? pre - 1: pre;
    });
    focusGraph.forEach(idx => {
        let pre = roundFocusGraph[data.round_id][idx];
        roundFocusGraph[data.round_id][idx] = pre? pre + 1: 1;
    });
}

async function computeCog(roundID, edges_saved, time, tilesPerRow, tilesPerColumn, nodesAndHints){
    var totalLinks = 2 * tilesPerRow * tilesPerColumn - tilesPerRow -tilesPerColumn;
    var completeLinks = 0;
    var correctLinks = 0;
    var totalHints = 0;

    var allPlayersTotalLinks = 0;
    var allPlayersCorrectLinks = 0;

    var brief_edges_saved = {};
    for (var e in edges_saved) {
        var edge = edges_saved[e];
        var supporters = edge.supporters;
        var opposers = edge.opposers;
        var sLen = Object.getOwnPropertyNames(supporters).length;
        var oLen = Object.getOwnPropertyNames(opposers).length;
        var wp = edge.weight;
        var confidence = edge.confidence;
        var wn = 0;
        if(confidence > 0){
            wn = wp / confidence - wp;
        }
        else{
            for (var o in opposers) {
                wn += opposers[o];
            }
        }
        wp = Number(wp).toFixed(2);
        wn = Number(wn).toFixed(2);
        brief_edges_saved[e] = {
            wp: wp,
            wn: wn,
            sLen: sLen,
            oLen: oLen
        }
        if (sLen > 0) {
            allPlayersTotalLinks += sLen;
            completeLinks += 1;
            if(edge.tag == 'L-R'){
                if(edge.x + 1 == edge.y && edge.y % tilesPerRow != 0){
                    correctLinks += 1;
                    allPlayersCorrectLinks += sLen;
                }
            }
            else{
                if(edge.x + tilesPerColumn == edge.y){
                    correctLinks += 1;
                    allPlayersCorrectLinks += sLen;
                }
            }
        }
    }

    if (nodesAndHints) {
        var correctHints = 0;
        var hints = nodesAndHints.hints;
        for (var i = 0; i < hints.length; i++) {
            for (var d = 0; d < 4; d++) {
                if (hints[i][d] >= 0) {
                    totalHints += 1;
                }
            }
            if(i % tilesPerRow < tilesPerRow - 1){ //right
                if (i + 1 == hints[i][1] && i == hints[i+1][3]) {
                    correctHints += 1;
                }
            }
            if(i < (tilesPerColumn - 1) * tilesPerRow){ //bottom
                if (i + tilesPerRow == hints[i][2] && i == hints[i + tilesPerRow][0]) {
                    correctHints += 1;
                }
            }
        }
    }

    let gaLinks = 0;
    let gaCorrectLinks = 0;
    let gaEdgesJson = await redis.getAsync('round:' + roundID + ':GA_edges');
    let gaEdges = null;
    if (gaEdgesJson) {
        gaEdges = JSON.parse(gaEdgesJson);
        gaLinks = gaEdges.length;
        for (let i = 0; i < gaEdges.length; i++) {
            let e = gaEdges[i];
            let [l, r] = e.split('-');
            let x = parseInt(l.substr(0, l.length - 1));
            let tag = r[0] == 'R'? 'L-R': 'T-B';
            let y = parseInt(r.substr(1));
            if(tag == 'L-R'){
                if(x + 1 == y && y % tilesPerRow != 0){
                    gaCorrectLinks += 1;
                }
            }
            else{
                if(x + tilesPerColumn == y){
                    gaCorrectLinks += 1;
                }
            }
        }
    }

    var Cog = {
        round_id: roundID,
        time: time,
        correctLinks: correctLinks,
        correctHints: correctHints? correctHints: null,
        completeLinks: completeLinks,
        totalLinks: totalLinks,
        ga_edges: gaEdges? gaEdges: null,
        nodes: nodesAndHints? nodesAndHints.nodes: null,
        hints: nodesAndHints? nodesAndHints.hints: null,
        edges_saved: brief_edges_saved,
    }
    let redis_key = 'round:' + roundID + ':coglist';
    let last = await redis.lindexAsync(redis_key, -1);

    let brief_cog = {
        time: Math.round(time),
        correctHints: correctHints? correctHints: -1,
        totalHints: totalHints / 2,
        correctLinks: correctLinks,
        completeLinks: completeLinks,
        totalLinks: totalLinks,
        allPlayersTotalLinks: allPlayersTotalLinks,
        allPlayersCorrectLinks: allPlayersCorrectLinks,
        gaLinks,
        gaCorrectLinks,
    }
    if (last) {
        let last_cog = JSON.parse(last);
        if (parseInt(last_cog.correctLinks) >= brief_cog.correctLinks 
            && parseInt(last_cog.completeLinks) >= brief_cog.completeLinks 
            && parseInt(last_cog.correctHints) >= brief_cog.correctHints) {
            return;
        }
    }
    await redis.rpushAsync(redis_key, JSON.stringify(brief_cog));
    CogModel.create(Cog, function (err) {
        if (err) {
            console.log(err);
            return false;
        } else {
            return true;
        }
    });
}

function computeContribution(nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var hintsCount = 0;

    var contibutionMap = {};
    for (var x = 0; x < hints.length; x++) {
        for(var d = 0; d < 4; d++){
            var direction = undefined;
            switch(d){
                case 0: direction = 'up'; break;
                case 1: direction = 'right'; break;
                case 2: direction = 'bottom'; break;
                case 3: direction = 'left'; break;
                default: break;
            }
            if(hints[x][d] >= 0 && nodes[x][direction]){
                hintsCount += 1;
                var y = hints[x][d];
                var edge = nodes[x][direction].indexes[y].edge;
                var weight = edge.weight;
                var supporters = edge.supporters;
                for (var s in supporters) {
                    var contribution = supporters[s] / weight;
                    if(!contibutionMap[s]){
                        contibutionMap[s] = 0;
                    }
                    contibutionMap[s] += contribution;
                }
            }
        }
    }

    var sum = 0;
    var latestPlayer = undefined;
    for(var p in contibutionMap){
        contibutionMap[p] /= hintsCount;
        contibutionMap[p] = Number(Number(contibutionMap[p]).toFixed(5));
        sum += contibutionMap[p];
        latestPlayer = p;
    }
    if(latestPlayer){
        contibutionMap[latestPlayer] += 1 - sum;
    }

    return contibutionMap;
}

function mergyGA(round_id, time, ga_json, nodesAndHints){
    let hints = nodesAndHints.hints;
    let hints_json = JSON.stringify(hints);
    DiffModel.create({
        round_id: round_id,
        time: time,
        ga_edges: ga_json,
        hints: hints_json
    }, function (err) {
        if (err) {
            console.log(err);
            return false;
        }
        else {
            return true;
        }
    });
    let ga_edges = JSON.parse(ga_json);
    nodesAndHints.GA_edges = ga_edges;
    let mergedHints = new Array(hints.length);
    for (var i = 0; i < hints.length; i++) {
        mergedHints[i] = [-1, -1, -1, -1];
    }
    for(let edge of ga_edges){
        let sp = edge.split('-');
        let x = parseInt(sp[0].substr(0, sp[0].length - 1));
        let y = parseInt(sp[1].substr(1));
        let tag = sp[1][0] == 'R' ? 'L-R' : 'T-B';
        if(tag == 'L-R'){
            if (hints[x][1] == y && hints[y][3] == x) {
                mergedHints[x][1] = y;
                mergedHints[y][3] = x;
            }
        }
        else {
            if (hints[x][2] == y && hints[y][0] == x) {
                mergedHints[x][2] = y;
                mergedHints[y][0] = x;
            }
        }
    }
    return mergedHints;
}

function getPlayersData(data) {
    return new Promise(async (resolve, reject) => {
        let redis_players_key = 'round:' + data.round_id + ':distributed:players';
        let players = await redis.srandmemberAsync(redis_players_key, 4);
        //console.log(players);
        let playersData = new Array();
        let playersPro = new Array();
        let zeroCount = 0;
        let minPro = 1;
        let proSum = 0;
        for (let i = 0; i < players.length; i++) {
            let player = players[i];
            if (player == data.player_name) {
                continue;
            }
            let results = await Promise.join(
                redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_sup', player),
                redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_opp', player),
                redis.smembersAsync('round:' + data.round_id + ':distributed:sup_edges:' + player),
            );
            //console.log(results);
            let sup = results[0] ? parseInt(results[0]): 0;
            let opp = results[1] ? parseInt(results[1]): 0;
            let edges = results[2] ? results[2]: [];
            playersData.push({
                from: player, 
                sup: sup,
                opp: opp,
                edges: edges
            });
            if(sup + opp > 0) {
                let pro = sup / (sup + opp)
                playersPro.push(pro);
                proSum += pro;
                minPro = Math.min(minPro, pro);
            } else {
                zeroCount += 1;
                playersPro.push(0);
            }
        }
        proSum += zeroCount * minPro;
        for (let i = 0; i < playersPro.length; i++) {
            let pro = playersPro[i];
            playersPro[i] = (pro > 0 ? pro : minPro) / proSum;
        }
        //console.log(playersPro);
        let results = await Promise.join(
            redis.zrangeAsync('round:' + data.round_id + ':distributed:edge_sup', 0, -1, 'WITHSCORES'),
            redis.zrangeAsync('round:' + data.round_id + ':distributed:edge_opp', 0, -1, 'WITHSCORES')
        );
        if (playersData.length <= 2) {
            resolve({
                players: playersData,
                edge_sup: results[0],
                edge_opp: results[1]
            });
            return;
        }
        let winnersData = new Array();
        while(winnersData.length < 2) {
            let rand = Math.random();
            let preProSum = 0;
            let winner_idx = -1;
            while(preProSum < rand && winner_idx < playersPro.length) {
                winner_idx += 1;
                preProSum += playersPro[winner_idx];
            }
            if (winner_idx >= 0) {
                winnersData.push(playersData[winner_idx]);
            }
        } 
        //console.log(winnersData);
        resolve({
            players: winnersData,
            edge_sup: results[0],
            edge_opp: results[1]
        });
    });
}


//准备并获取动作日志
function preGetAction(imageSrc, tilesPerRow){
    //查询历史数据：1.是影子拼图模式,2.已完成
    let condition = {
        image: imageSrc,
        tilesPerRow: tilesPerRow,
        algorithm: 'shadow',
        solved_players: {$gte: 1}
    };
    RoundModel.find(condition, function (err, doc) {
        if (err) {
            console.log(err);
        } else {
            if (doc && doc.length>0) {
                history_round_id = doc[0].round_id;
                let actionCondition={
                    round_id: history_round_id
                };
                ActionModel.find(actionCondition,function(err,doc){
                    if(err){
                        console.log(err);
                    }else{
                        if(doc){
                            actionData=doc;
                        }
                    }
                });
            }else{
                history_round_id = undefined;
            }
        }
    }).sort({round_id: -1});
}

//开始执行动作日志
function getAction(actionData){
    if(actionData){
        console.log("actionData.length",actionData.length);
        for(var i=0;i<actionData.length;i++){
            historyData[i] = {
                _id: undefined,
                round_id: nowround_id,
                player_name: actionData[i].player_name,
                is_hint: actionData[i].is_hint,
                edges: actionData[i].links_size,
                time: actionData[i].time,
                logs: 0
            }
        }
        if(historyData.length>0){
            preTime=historyData[k].time;
            startGetAction = setInterval(updateHistory,historyData[k].time-preTime+100);
        }
    }
}
//同步更新action
function updateHistory(){
    if(k<historyData.length){
        updateWrapper(historyData[k]);
        preTime=historyData[k].time;
        k=k+1;
        clearInterval(startGetAction);
        if(k<historyData.length){
            startGetAction=setInterval(updateHistory,historyData[k].time-preTime+100);
        }
    }
}

module.exports = function (io) {
    io.on('connection', function (socket) {
        socket.on('uploadForGA', function (data) {
            updateForGAWrapper(data);
        });

        socket.on('distributed_upload', function (data) {
            distributedUpdateWrapper(data);
        });

        socket.on('upload', function (data) {
            // console.log(isShadow,nowround_id,history_round_id);
            //nowround_id确保第一次上传的时候为空，然后赋值，启动更新数据，之后再有upload消息则不执行这段
            if(isShadow==true && nowround_id==undefined&& history_round_id!=undefined){
                nowround_id=data.round_id;
                // isRandomGame=false;
                // console.log("execute shadow upload:",nowround_id);
                getAction(actionData);
            }
            updateWrapper(data);
        });

        socket.on('distributed_fetchHints', async function(data) {
            let playersData = await getPlayersData(data);
            socket.emit('distributed_proactiveHints', {
                players: playersData.players,
                edge_sup: playersData.edge_sup,
                edge_opp: playersData.edge_opp,
                roundFocusGraph: roundFocusGraph[data.round_id]
            });
        });

        socket.on('getHisAction',function(data){
            console.log("getHisAction isShadow:",data.algorithm);
            if(data.algorithm=='shadow'){
                isShadow=true;
            }
            //把之前的遍历都重置
            nowround_id=undefined;//当前游戏id
            history_round_id=undefined;//历史游戏id
            clearInterval(startGetAction);//清除计时器
            k=0;//
            history_imageURL = data.imageURL;//获得前端选取的图片(若是random模式，这里为空)
            //若不是影子模式或者没有图片路径则不查询历史数据
            if(isShadow && history_imageURL!=undefined){
                console.log("get HistoryData");
                //查询历史数据。
                preGetAction(data.imageURL, data.imageSize);
            }
        });

        socket.on('randomGetAction',function(data){
            console.log("randomGetAction isShadow:",data.algorithm);
            if(data.algorithm=='shadow'){
                isShadow=true;
            }
            //nowround_id=data.round_id;
            nowround_id = undefined;
            history_round_id=undefined;
            clearInterval(startGetAction);
            history_imageURL = data.imageURL;
            k=0;
            // isRandomGame=true;
            if(isShadow && history_imageURL!=undefined){
                // console.log("get random HistoryData nowround_id:",nowround_id);
                preGetAction(data.imageURL, data.imageSize);
            }
        });
        //
        socket.on('stopUpdateHistory',function(data){
            // console.log("stopUpdateHistory",data);
            clearInterval(startGetAction);
            nowround_id=undefined;
            history_round_id=undefined;
            isShadow=false;
            k=0;
        });
        // request global hints
        socket.on('fetchHints', function (data) {
            var hints = [];
            var unsureHints = {};
            var roundID = data.round_id;
            var tilesNum = data.tilesNum;
            var nodesAndHints = getNodesAndHints(roundID, tilesNum, {});
            if(nodesAndHints){
                hints = nodesAndHints.hints;
                unsureHints = nodesAndHints.unsureHints;
                let redis_key = 'round:' + roundID + ':GA_edges';
                redis.get(redis_key, function(err, doc){
                    if(doc){
                        hints = mergyGA(roundID, Date.now(), doc, nodesAndHints)
                    }
                    socket.emit('proactiveHints', {
                        sureHints: hints,
                        unsureHints: unsureHints,
                        edgeMap: nodesAndHints.edgeMap,
                        roundFocusGraph: roundFocusGraph[data.round_id]
                    });
                });
            }
        });

        socket.on('distributed_getHintsAround', async function(data) {
            let playersData = await getPlayersData(data);
            socket.emit('distributed_reactiveHints', {
                players: playersData.players,
                edge_sup: playersData.edge_sup,
                edge_opp: playersData.edge_opp,
                indexes: data.indexes,
                selectedTileIndexes: data.selectedTileIndexes,
                currentStep: data.currentStep,
                roundFocusGraph: roundFocusGraph[data.round_id]
            });
        });

        // request localhints(around the selected tile)
        socket.on('getHintsAround', function (data) {
            var hints = [];
            var unsureHints = {};
            var roundID = data.round_id;
            var tilesNum = data.tilesNum;
            var nodesAndHints = getNodesAndHints(roundID, tilesNum, {});
            if(nodesAndHints){
                hints = nodesAndHints.hints;
                unsureHints = nodesAndHints.unsureHints;
                let redis_key = 'round:' + roundID + ':GA_edges';
                redis.get(redis_key, function(err, doc){
                    if(doc){
                        hints = mergyGA(roundID, Date.now(), doc, nodesAndHints)
                    }
                    socket.emit('reactiveHints', {
                        indexes: data.indexes,
                        selectedTileIndexes: data.selectedTileIndexes,
                        currentStep: data.currentStep,
                        sureHints: hints,
                        unsureHints: unsureHints,
                        edgeMap: nodesAndHints.edgeMap,
                        roundFocusGraph: roundFocusGraph[data.round_id]
                    });
                });
            }
        });
    });

    function LoginFirst(req, res, next) {
        if (!req.session.user) {
            req.session.error = 'Please Login First!';
            return res.redirect('/login');
            //return res.redirect('back');
        }
        next();
    }

    /**
     * Access Control
     * @param {*} req 
     * @param {*} res 
     * @param {*} next 
     */
    function JoinRoundFirst(req, res, next) {

        RoundModel.findOne({ round_id: req.params.round_id }, { _id: 0, players: 1 }, function (err, doc) {
            if (err) {
                console.log(err);
            } else {
                if (doc) {
                    let hasJoined = doc.players.some(function (p) {
                        return (p.player_name == req.session.user.username);
                    });
                    if (!hasJoined) {
                        req.session.error = "You haven't joined this Round!";
                        return res.redirect('/home');
                    }
                    next();
                } else {
                    return res.redirect('/home');
                }
            }
        });
    }
    return router;
}