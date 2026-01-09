require('dotenv').config();
const fetch = require('node-fetch');
const Discord = require('discord.js');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { exec, execSync } = require('child_process');
const execPromise = util.promisify(exec);
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = (client) => {
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;
        if (commandName == 'stitch') {
            const userID = interaction.user.id
            const link = interaction.options.getString('link')
            const height = interaction.options.getInteger('height')
            const format = interaction.options.getString('format')
            const width = interaction.options.getInteger('width')

            let fileID
            if (link.split('?id=').length == 2) {
                fileID = link.split('?id=')[1]
            } else if (link.split('?usp=').length == 0) {
                fileID = link.split('/')[5]
            } else if (link.split('?').length == 0) {
                fileID = link.split('/')[5]
            } else {
                fileID = link.split('/')[5].split('?')[0]
            }

            const pinteraction = await interaction.deferReply({ content: 'Processing...', fetchReply: true });

            let folderName
            let folderName1
            try {
                // Get folder info
                const folderInfo = execSync(`gdrive files info ${fileID}`)
                if (folderInfo) {
                    const infoOutput = Buffer.from(folderInfo, 'utf-8').toString()
                    console.log(infoOutput)
                    const timestamp = new Date().getTime()
                    const arg = infoOutput.split("\n")
                    const nameArgs = arg[1].split(": ")
                    folderName = nameArgs[1] + "-" + timestamp
                    folderName1 = nameArgs[1]
                }
            } catch (err) {
                console.error("Error fetching gdrive info:", err);
                return interaction.followUp({ content: "❌ Error fetching folder info. Please check the link and try again.", ephemeral: true });
            }

            let outputPAth
            let StitchPath

            // Setup paths - consistently use underscores for the parent folder to match Dwnloadpath
            // Use raw paths for fs/cwd (no quotes), quote only in shell commands
            const parentFolderPath = folderName.replace(/ /g, "_");

            outputPAth = path.join(__dirname, 'downloads', userID, parentFolderPath, folderName1, `${folderName1}_Stitched`);
            StitchPath = path.join(__dirname, 'downloads', userID, parentFolderPath, folderName1);

            const Dwnloadpath = path.join(__dirname, 'downloads', userID, parentFolderPath);

            // Ensure download directory exists
            if (!fs.existsSync(Dwnloadpath)) {
                fs.mkdirSync(Dwnloadpath, { recursive: true });
            }

            try {
                // Step 1: Download
                console.log(`[Download] Downloading to: ${Dwnloadpath}`);
                await execPromise(`gdrive files download ${fileID} --overwrite --recursive --destination "${Dwnloadpath}"`);

                // Step 2: Unzip/Prepare
                console.log(`[Prepare] Checking for compressed files...`);
                const getAllFiles = (dir) => {
                    let results = [];
                    const list = fs.readdirSync(dir);
                    list.forEach(file => {
                        file = path.join(dir, file);
                        const stat = fs.statSync(file);
                        if (stat && stat.isDirectory()) results = results.concat(getAllFiles(file));
                        else if (file.endsWith('.zip')) results.push(file);
                    });
                    return results;
                }

                const zips = getAllFiles(Dwnloadpath);
                if (zips.length > 0) {
                    console.log(`[Prepare] Found ${zips.length} zip files. Extracting...`);
                    for (const zip of zips) {
                        try {
                            const dest = path.dirname(zip);
                            // Unzip and delete the zip file
                            await execPromise(`unzip -o "${zip}" -d "${dest}"`);
                            fs.unlinkSync(zip); 
                        } catch (e) { 
                            console.error(`[Prepare] Failed to unzip ${zip}`, e); 
                        }
                    }
                    
                    // If proper StitchPath is gone (e.g. it was the zip file), update it to Dwnloadpath
                    if (!fs.existsSync(StitchPath)) {
                        console.log(`[Prepare] StitchPath missing after unzip (was likely the zip file). Updating to: ${Dwnloadpath}`);
                        StitchPath = Dwnloadpath;
                    }
                }

                // If StitchPath is a file (e.g. downloaded a single file not zip), use its directory
                if (fs.existsSync(StitchPath) && fs.lstatSync(StitchPath).isFile()) {
                     StitchPath = path.dirname(StitchPath);
                }

                // Construct processing steps dynamically with possibly updated StitchPath
                let stitchCmd = `SmartStitch -i "${StitchPath}" -sh ${height} -t .${format}`;
                if (width != null) {
                    stitchCmd += ` -cw ${width}`;
                }

                const processWorkflow = [
                    {
                        name: 'Stitch',
                        command: stitchCmd
                    },
                    {
                        name: 'Zip',
                        command: `zip -r chapter-${folderName1.replace(/ /g, "_")}.zip *`,
                        options: {
                            cwd: outputPAth
                        }
                    },
                    {
                        name: 'Upload',
                        command: `rclone copy "${outputPAth}" Golden1:/stitched_BOT/${folderName1.replace(/ /g, "_")}_Stitched`,
                    },
                    {
                        name: 'Link',
                        command: `rclone link Golden1:/stitched_BOT/${folderName1.replace(/ /g, "_")}_Stitched`,
                        isResult: true
                    }
                ];

                // Execute processing commands
                for (const step of processWorkflow) {
                    console.log(`[${step.name}] Executing: ${step.command}`);

                    const { stdout, stderr } = await execPromise(step.command, step.options || {});

                    if (stdout) console.log(`[${step.name}] stdout: ${stdout}`);
                    if (stderr) console.log(`[${step.name}] stderr: ${stderr}`);

                    // Handle result
                    if (step.isResult) {
                        try {
                            await interaction.user.send(`chapter-${folderName1}: ${stdout}`);
                            await interaction.followUp({ content: "See Your DM", ephemeral: true });
                            const message = await interaction.fetchReply();
                            message.react("✅");
                        } catch (dmError) {
                            console.error("Failed to send DM:", dmError);
                            await interaction.followUp({ content: `Finished, but failed to DM. Link: ${stdout}`, ephemeral: true });
                        }
                    }
                }
            } catch (err) {
                console.error("Workflow failed:", err);
                await interaction.followUp({ content: `❌ An error occurred during the process. Please check the logs.`, ephemeral: true });
            } finally {
                // Cleanup downloaded files
                try {
                    if (fs.existsSync(Dwnloadpath)) {
                        console.log(`Cleaning up: ${Dwnloadpath}`);
                        fs.rmSync(Dwnloadpath, { recursive: true, force: true });
                    }
                } catch (cleanupErr) {
                    console.error("Cleanup failed:", cleanupErr);
                }
            }
        }
    })
}