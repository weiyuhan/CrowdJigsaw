'use strict'
/**
 * API operations related with the sequence&links
 * 
 */

var express = require('express');
var router = express.Router();
const mongoose = require('mongoose');
var NodeModel = require('../models/node').Node;
var RoundModel = require('../models/round').Round;
var ActionModel = require('../models/action').Action;
var util = require('./util.js');
var constants = require('../config/constants');

/**
 * Get the best link with different strategies
 * @param {*} links
 */
function getBest(links) {
    if (links) {
        let sortedLinks = links.sort(util.descending("sup_num"));
        return sortedLinks[0].index;
    } else {
        console.log("Unreachable.");
    }
}

/**
 * Generate a solution and test if correct
 */
function generateSolution(round_id, row_num, tile_num) {
    var dirs = ['top', 'right', 'bottom', 'left'];
    NodeModel.find({ round_id: round_id }, function (err, docs) {
        if (err) {
            console.log(err);
        } else {
            // for every node, find its most supported link            
            let solution = new Array();
            // if not all nodes are visited, just return false
            if (docs) {
                for (let node of docs) {
                    /* One a node are not complete yet, not feasible
                     * for every directions, judge if there is tile
                     * if yes, try to get a tile
                     */
                    // top
                    let top = -1;
                    if (node.index - row_num >= 0) {
                        if (node.top.length > 0) {
                            top = getBest(node.top);
                        }
                    } else {
                        top = -2;// out of the map
                    }
                    // right
                    let right = -1;
                    if (((node.index + 1)) < tile_num && (node.index + 1) % row_num != 0) {
                        if (node.right.length > 0) {
                            right = getBest(node.right);
                        }
                    } else {
                        right = -2;//  out of the map
                    }
                    // bottom
                    let bottom = -1;
                    if (node.index + row_num < tile_num) {
                        if (node.bottom.length > 0) {
                            bottom = getBest(node.bottom);
                        }
                    } else {
                        bottom = -2;//  out of the map
                    }
                    // left
                    let left = -1;
                    if (node.index - 1 >= 0 && node.index % row_num != 0) {
                        if (node.left.length > 0) {
                            left = getBest(node.left);
                        }
                    } else {
                        left = -2;//  out of the map
                    }
                    // form the node's neighbors
                    if (top != -1 && right != -1 && bottom != -1 && left != -1) {
                        let temp = {
                            "index": node.index,
                            "top": top,
                            "right": right,
                            "bottom": bottom,
                            "left": left
                        };
                        solution.push(temp);
                    }
                }

                // console.log(solution);
                // return colletive finished or not
                // if true, notify the user and record the time
                if (solution.length == tile_num) {
                    // console.log("Feasible");
                    // Test if the feasible solution is correct
                    if (testSolution(row_num, tile_num, solution)) {
                        // if correct, save the time&tell the users
                        RoundModel.findOneAndUpdate({ round_id: round_id },
                            { $set: { collective_time: util.getNowFormatDate() } },
                            { new: true }, function (err, doc) {
                                if (err) {
                                    console.log(err);
                                } else {
                                    console.log('Round' + round_id + ': Crowd bingo! @' + doc.collective_time);
                                }
                            });
                    }
                } else {
                    // console.log("Not feasible yet.");
                    return false;
                }
            }
        }
    });
}

/**
 * Test the collective solution, just return it is right or false
 */
function testSolution(row_num, tile_num, solution) {
    // to test for every node, once wrong, break and return.
    let result = true;
    for (let node of solution) {
        if (node.index - row_num >= 0) {
            if (node.top != node.index - row_num) {
                result = false;
                return false;
            }
        }
        // right
        if (node.index + 1 < tile_num && (node.index + 1) % row_num != 0) {
            if (node.right != node.index + 1) {
                result = false;
                return false;
            }
        }
        // bottom
        if (node.index + row_num < tile_num) {
            if (node.bottom != node.index + row_num) {
                result = false;
                return false;
            }
        }
        // left
        if (node.index - 1 >= 0 && node.index % row_num != 0) {
            if (node.left != node.index - 1) {
                result = false;
                return false;
            }
        }
    }
    return result;
}



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
            contribution = -1;
            break;
        case "-":
            contribution = 0 - Math.pow(alpha, num_before);
            break;
        default:
            contribution = 0;
    }
    return contribution;
}

/**
 * Write one action into the action sequence
 */
function writeAction(NAME, round_id, operation, from, direction, to, contri) {
    ActionModel.find({ round_id: round_id }, function (err, docs) {
        if (err) {
            console.log(err);
        } else {
            let aid = docs.length;
            var action = {
                round_id: round_id,
                action_id: aid,
                time_stamp: util.getNowFormatDate(),
                player_name: NAME,
                operation: operation,
                from: from,
                direction: direction,
                to: to,
                contribution: contri
            };
            ActionModel.create(action, function (err) {
                if (err) {
                    console.log(err);
                    return false;
                } else {
                    return true;
                }
            });
            // Update the players contribution in this round
            RoundModel.findOneAndUpdate(
                { round_id: round_id, "players.player_name": NAME },
                { $inc: { "players.$.contribution": contri } },
                // { new: true },
                function (err) {
                    if (err) {
                        console.log(err);
                    } 
                    // else {
                    //     generateSolution(round_id, doc.row_num, doc.tile_num);
                    //     // console.log(doc);
                    // }
                });
        }
    });
}

// Bidirectionally add one link to the other side
function mutualAdd(round_id, from, to, dir) {

    NodeModel.findOne({ round_id: round_id, index: from }, function (err, doc) {
        if (err) {
            console.log(err);
        } else {
            if (!doc) {
                // create the from node
                let new_node = {
                    round_id: round_id,
                    index: from
                };
                NodeModel.create(new_node, function (err) {
                    if (err) {
                        console.log(err);
                    } else {
                        // and push a new one
                        let temp = {};
                        temp[dir] = {
                            index: to,
                            sup_num: 1
                        };
                        NodeModel.update(
                            { round_id: round_id, index: from },
                            { $push: temp },
                            function (err) {
                                if (err) {
                                    console.log(err);
                                }
                            });
                    }
                });
            } else {
                // the from node exists
                // check if the 
                if (doc[dir].length == 0) {
                    // not exists
                    // push a new one
                    let temp = {};
                    temp[dir] = {
                        index: to,
                        sup_num: 1
                    };
                    NodeModel.update(
                        { round_id: round_id, index: from },
                        { $push: temp },
                        function (err) {
                            if (err) {
                                console.log(err);
                            }
                        });
                } else {
                    // check if the to link exists
                    let existed = false;
                    for (let i of doc[dir]) {
                        if (i.index == to) {
                            // if yes, inc the node
                            existed = true;
                            let condition = {
                                round_id: round_id, index: from
                            };
                            condition[dir + '.index'] = to;
                            let temp = {};
                            temp[dir + '.$.sup_num'] = 1;
                            NodeModel.update(condition,
                                { $inc: temp },
                                function (err) {
                                    if (err) {
                                        console.log(err);
                                    }
                                });
                        }
                    }
                    // if not, push a new one
                    if (!existed) {
                        // ++
                        let temp = {};
                        temp[dir] = {
                            index: to,
                            sup_num: 1
                        };
                        NodeModel.update(
                            { round_id: round_id, index: from },
                            { $push: temp },
                            function (err) {
                                if (err) {
                                    console.log(err);
                                }
                            });
                    }
                }
            }
        }
    });
}


/**
 * Bidirectionally remove one link to the other side
 */
function mutualRemove(round_id, from, to, dir) {
    NodeModel.findOne({ round_id: round_id, index: from }, function (err, doc) {
        if (err) {
            console.log(err);
        } else {
            if (doc) {
                // it's sure that it exists
                if (doc[dir].length > 0) {
                    // --/-
                    let condition = {
                        round_id: round_id, index: from
                    };
                    condition[dir + '.index'] = to;
                    let temp = {};
                    temp[dir + '.$.sup_num'] = -1;
                    temp[dir + '.$.opp_num'] = 1;
                    NodeModel.find(condition, function (err, doc) {
                            if (err) {
                                console.log(err);
                            }else{
                                NodeModel.update(condition, { $inc: temp }, function (err) {
                                    if(err){
                                        console.log(err);
                                    }
                                });
                            }
                        });
                }
            }
        }
    });
}

/**
 * Check the links and format the action object
 * Bidirectionally
 */
router.route('/check').all(LoginFirst).post(function (req, res, next) {
    let round_id = req.body.round_id;
    var NAME = req.session.user.username;

    let selected = req.body.selectedTile;
    let around = JSON.parse(req.body.aroundTiles);
    let msgs = new Array();
    // For every posted nodes, add them to the nodes(graph), and decide which way 
    var dirs = ['top', 'right', 'bottom', 'left'];
    var reverseDirs = ['bottom', 'left', 'top', 'right'];
    NodeModel.findOne({ round_id: round_id, index: selected }, function (err, doc) {
        if (err) {
            console.log(err);
        } else {
            if (!doc) { // Case1: Add(node not existed)
                // new a node and new the links
                // all ++
                let new_node = {
                    round_id: round_id,
                    index: selected
                };
                NodeModel.create(new_node, function (err) {
                    if (err) {
                        console.log(err);
                        res.send({ msg: err });
                    } else {
                        for (let d = 0; d < around.length; d++) { // d=0,1,2,3
                            let to = around[d];
                            if (to.before != to.after) {
                                // In practice, to.before is bound to be -1
                                if (to.before == -1) {
                                    let temp = {};
                                    temp[dirs[d]] = {
                                        index: to.after,
                                        sup_num: 1
                                    };
                                    NodeModel.update(
                                        { round_id: round_id, index: selected },
                                        { $push: temp },
                                        function (err) {
                                            if (err) {
                                                console.log(err);
                                            } else {
                                                writeAction(NAME, round_id, "++", selected, dirs[d], to.after, calcContri("++", 0));
                                                // res.send({msg:'++ ' + selected + '-' + dirs[d] + '->' + to.after});
                                                mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                            }
                                        });
                                } else if (to.after == -1) {
                                    console.log("Unreachable case1.");
                                } else { // to.before!=to.after!=-1
                                    console.log("Unreachable case2.");
                                }
                            }
                        }
                        res.send({ msg: 'success' });
                        // res.send({ msg: JSON.stringify(msgs) });
                    }
                });
            } else {
                // this node in this round already exists
                for (let d = 0; d < around.length; d++) { // d=0,1,2,3
                    let to = around[d];
                    if (to.before != to.after) {
                        if (to.before == -1) {  // Case2: Add(node existed, -1 to !-1)
                            if (doc[dirs[d]].length == 0) {
                                // ++ in global view
                                let temp = {};
                                temp[dirs[d]] = {
                                    index: to.after,
                                    sup_num: 1
                                };
                                NodeModel.update(
                                    { round_id: round_id, index: selected },
                                    { $push: temp },
                                    function (err) {
                                        if (err) {
                                            console.log(err);
                                        } else {
                                            writeAction(NAME, round_id, "++", selected, dirs[d], to.after, calcContri("++", 0));
                                            // res.send({msg:'++ ' + selected + '-' + dirs[d] + '->' + to.after});
                                            mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                        }
                                    });
                            } else {
                                let existed = false;
                                for (let i of doc[dirs[d]]) {
                                    if (i.index == to.after) {
                                        // + 
                                        existed = true;
                                        let condition = {
                                            round_id: round_id, index: selected
                                        };
                                        condition[dirs[d] + '.index'] = to.after;
                                        let temp = {};
                                        temp[dirs[d] + '.$.sup_num'] = 1;
                                        let sup_before = i.sup_num;

                                        NodeModel.update(condition,
                                            { $inc: temp },
                                            function (err, doc) {
                                                if (err) {
                                                    console.log(err);
                                                } else {
                                                    writeAction(NAME, round_id, "+", selected, dirs[d], to.after, calcContri("+", sup_before));
                                                    // res.send({msg:'+ ' + selected + '-' + dirs[d] + '->' + to.after});
                                                    mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                                }
                                            });
                                    }
                                }
                                if (!existed) {
                                    // ++
                                    let temp = {};
                                    temp[dirs[d]] = {
                                        index: to.after,
                                        sup_num: 1
                                    };
                                    NodeModel.update(
                                        { round_id: round_id, index: selected },
                                        { $push: temp },
                                        function (err) {
                                            if (err) {
                                                console.log(err);
                                            } else {
                                                writeAction(NAME, round_id, "++", selected, dirs[d], to.after, calcContri("++", 0));
                                                // res.send({msg:'++ ' + selected + '-' + dirs[d] + '->' + to.after});
                                                mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                            }
                                        });
                                }
                            }
                        } else if (to.after == -1) { // Case3: Remove(edge existed, !-1 to -1)
                            // assert: existed&&sup_num>=1
                            if (doc[dirs[d]].length > 0) {
                                // --/-
                                let condition = {
                                    round_id: round_id, index: selected
                                };
                                condition[dirs[d] + '.index'] = to.before;
                                let temp = {};
                                temp[dirs[d] + '.$.sup_num'] = -1;
                                temp[dirs[d] + '.$.opp_num'] = 1;
                                NodeModel.findOne(condition, function (err, doc) {
                                    if (err) {
                                        console.log(err);
                                    } else {
                                        if (doc) {
                                            let op = "";
                                            let opp_before = 0;
                                            for (let i of doc[dirs[d]]) {
                                                if (i.index == to.before) {
                                                    op = i.sup_num <= 1 ? "--" : "-"; // 0/1-1=-1/0;
                                                    opp_before = i.opp_num;
                                                }
                                            }
                                            NodeModel.update(condition, { $inc: temp }, function (err) {
                                                if (err) {
                                                    console.log(err);
                                                } else {
                                                    writeAction(NAME, round_id, op, selected, dirs[d], to.before, calcContri(op, opp_before));
                                                    // res.send(op + ' ' + selected + '-' + dirs[d] + '->' + to.before);
                                                    mutualRemove(round_id, to.before, selected, reverseDirs[d]);
                                                }
                                            });
                                        }
                                    }
                                });
                                // NodeModel.findOneAndUpdate(condition,
                                //     { $inc: temp }, { new: true }, // return the modified doc
                                //     function (err, doc) {
                                //         if (err) {
                                //             console.log(err);
                                //         } else {
                                //             let op = "";
                                //             let opp_before = 0;
                                //             for (let i of doc[dirs[d]]) {
                                //                 if (i.index == to.before) {
                                //                     op = i.sup_num <= 0 ? "--" : "-";
                                //                     opp_before = i.opp_num - 1;
                                //                 }
                                //             }
                                //             writeAction(NAME, round_id, op, selected, dirs[d], to.before, calcContri(op, opp_before));
                                //             // res.send({msg:op + ' ' + selected + '-' + dirs[d] + '->' + to.before});
                                //             mutualRemove(round_id, to.before, selected, reverseDirs[d]);
                                //         }
                                //     });
                            }
                        } else { // Case4: Update(to.before!=to.after!=-1)
                            // - 
                            var to_send = {};
                            let condition = {
                                round_id: round_id, index: selected
                            };
                            condition[dirs[d] + '.index'] = to.before;
                            let temp = {};
                            temp[dirs[d] + '.$.sup_num'] = -1;
                            temp[dirs[d] + '.$.opp_num'] = 1;
                            NodeModel.findOne(condition, function (err, doc) {
                                if (err) {
                                    console.log(err);
                                } else {
                                    if (doc) {
                                        let op = "";
                                        let opp_before = 0;
                                        for (let i of doc[dirs[d]]) {
                                            if (i.index == to.before) {
                                                op = i.sup_num <= 1 ? "--" : "-"; // 0/1-1=-1/0;
                                                opp_before = i.opp_num;
                                            }
                                        }
                                        NodeModel.update(condition, { $inc: temp }, function (err) {
                                            if (err) {
                                                console.log(err);
                                            } else {
                                                writeAction(NAME, round_id, op, selected, dirs[d], to.before, calcContri(op, opp_before));
                                                // res.send(op + ' ' + selected + '-' + dirs[d] + '->' + to.before);
                                                mutualRemove(round_id, to.before, selected, reverseDirs[d]);
                                            }
                                        });
                                    }
                                }
                            });
                            // NodeModel.findOneAndUpdate(condition,
                            // { $inc: temp }, { new: true },
                            // function (err, doc) {
                            //     if (err) {
                            //         console.log(err);
                            //     } else {
                            //         if (!doc){
                            //             let op = "";
                            //             let opp_before = 0;
                            //             for (let i of doc[dirs[d]]) {
                            //                 if (i.index == to.before) {
                            //                     op = i.sup_num <= 0 ? "--" : "-";
                            //                     opp_before = i.opp_num - 1;
                            //                 }
                            //             }
                            //             writeAction(NAME, round_id, op, selected, dirs[d], to.before, calcContri(op, opp_before));
                            //             // res.send(op + ' ' + selected + '-' + dirs[d] + '->' + to.before);
                            //             mutualRemove(round_id, to.before, selected, reverseDirs[d]);
                            //         }
                            //     }
                            // });
                            // +
                            let existed = false;
                            for (let i of doc[dirs[d]]) {
                                if (i.index == to.after) {
                                    existed = true;
                                    let condition = {
                                        round_id: round_id, index: selected
                                    };
                                    condition[dirs[d] + '.index'] = to.after;
                                    let temp = {};
                                    temp[dirs[d] + '.$.sup_num'] = 1;
                                    let sup_before = i.sup_num;
                                    NodeModel.update(condition,
                                        { $inc: temp },
                                        function (err, doc) {
                                            if (err) {
                                                console.log(err);
                                            } else {
                                                writeAction(NAME, round_id, "+", selected, dirs[d], to.after, calcContri("+", sup_before));
                                                // res.send({msg:'+ ' + selected + '-' + dirs[d] + '->' + to.after});
                                                mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                            }
                                        });
                                }
                            }
                            if (!existed) {
                                // ++
                                let temp = {};
                                temp[dirs[d]] = {
                                    index: to.after,
                                    sup_num: 1
                                };
                                NodeModel.update(
                                    { round_id: round_id, index: selected },
                                    { $push: temp },
                                    function (err) {
                                        if (err) {
                                            console.log(err);
                                        } else {
                                            writeAction(NAME, round_id, "++", selected, dirs[d], to.after, calcContri("++", 0));
                                            // res.send({msg:'++ ' + selected + '-' + dirs[d] + '->' + to.after});
                                            mutualAdd(round_id, to.after, selected, reverseDirs[d]);
                                        }
                                    });
                            }
                        }
                    }
                }
                res.send({ msg: 'success' });
            }
        }
    });
});


/**
 * Get hints from the current graph data
 * @return If sure: an array of recommended index, in 4 directions of the tile
 * @return If unsure: the latest tile that requires more information(highlight in the client to collect votes)
 */
var strategy = constants.strategy;
var unsure_gap=constants.unsure_gap;
router.route('/getHints/:round_id/:selected').all(LoginFirst).get(function (req, res) {
    // router.route('/getHints/:round_id/:selected').get(function (req, res) { // 4 Test
    // query the 4 dirs of the selected tile
    let condition = {
        round_id: req.params.round_id,
        index: req.params.selected
    };
    // find the most-supported one of every dir
    var hintIndexes = new Array();
    var dirs = ['top', 'right', 'bottom', 'left'];

    if (strategy == "conservative") {
        // Stratey1: conservative
        // get the players_num of the round
        RoundModel.findOne(condition, { _id: 0, players_num: 1 }, function (err, doc) {
            if (err) {
                console.log(err);
            } else {
                let players_num = doc.players_num;
                NodeModel.findOne(condition, function (err, doc) {
                    if (err) {
                        console.log(err);
                    } else {
                        if (!doc) {
                            res.send({ msg: "No hints." });
                        } else {
                            for (let d = 0; d < 4; d++) {
                                let alternatives = doc[dirs[d]];
                                if (alternatives.length == 0) {
                                    hintIndexes.push(-1);
                                } else {
                                    let most_sup = alternatives[0];
                                    for (let a of alternatives) {
                                        if (a.sup_num > most_sup.sup_num) {
                                            most_sup = a;
                                        }
                                    }
                                    // to guarantee zero sup nodes won't be hinted
                                    // 1/5 of the crowd have supported
                                    if (most_sup.sup_num > (players_num / 5)) {
                                        hintIndexes.push(most_sup.index);
                                    } else {
                                        hintIndexes.push(-1);
                                    }
                                }
                            }
                            res.send(JSON.stringify(hintIndexes));
                        }
                    }
                });
            }
        });
    } else if(strategy == "aggressive"){
        // Strategy 2: aggressive
        NodeModel.findOne(condition, function (err, doc) {
            if (err) {
                console.log(err);
            } else {
                if (!doc) {
                    res.send({ msg: "No hints." });
                } else {
                    for (let d = 0; d < 4; d++) {
                        let alternatives = doc[dirs[d]];
                        if (alternatives.length == 0) {
                            hintIndexes.push(-1);
                        } else {
                            let most_sup = alternatives[0];
                            for (let a of alternatives) {
                                if (a.sup_num > most_sup.sup_num) {
                                    most_sup = a;
                                }
                            }
                            if (most_sup.sup_num > 0) {
                                hintIndexes.push(most_sup.index);
                            } else {
                                hintIndexes.push(-1);
                            }
                        }
                    }
                    res.send(JSON.stringify(hintIndexes));
                }
            }
        });
    }else if (strategy == "considerate") {
       // Strategy 3: considerate
       var unsureLinks=new Array([],[],[],[]);
       NodeModel.findOne(condition, function (err, doc) {
           if (err) {
               console.log(err);
           } else {
               if (!doc) {
                   res.send({ msg: "No hints." });
               } else {
                   for (let d = 0; d < 4; d++) {
                       let alternatives = doc[dirs[d]];
                       if (alternatives.length == 0) {
                           hintIndexes.push(-1);
                       } else {
                           let best = alternatives[0];
                           let best_score=best.sup_num - best.opp_num;
                           for (let a of alternatives) {
                               let score=a.sup_num - a.opp_num;
                               if (score > 0 && score > best_score) {
                                   best = a;
                                   best_score=score;
                               }
                           }
                           for(let a of alternatives){
                               let score=a.sup_num - a.opp_num;
                               if(score > 0){
                                   if(score==best_score || score==best_score-unsure_gap){
                                       unsureLinks[d].push(a.index);
                                   }
                               }                                
                           }
                           // if only one best and no best-1
                           if (unsureLinks[d].length == 1) {
                               hintIndexes.push(unsureLinks[d][0]);
                               unsureLinks[d] = new Array();
                           } else {
                               // -2 means multiple choices available
                               hintIndexes.push(-2);
                           }
                       }
                   }
                   res.send({
                       "sure": JSON.stringify(hintIndexes),
                       "unsure": JSON.stringify(unsureLinks)
                   });
                }
            }
        });
    }
});


function LoginFirst(req, res, next) {
    if (!req.session.user) {
        req.session.error = 'Please Login First!';
        return res.redirect('/login');
        //return res.redirect('back');//返回之前的页面
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



module.exports = router;
